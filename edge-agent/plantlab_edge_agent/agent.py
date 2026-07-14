"""Main loop for the PlantLab edge agent - Parts 7-10, 14.

Deliberately mirrors scripts/agent-service.ts's loop shape (heartbeat,
camera inventory, poll-and-run-one-job, process due uploads, cleanup) so
the two implementations stay easy to compare, without sharing any code -
see docs/AGENT_PROTOCOL.md for the wire contract they both implement.

Resource safeguards (Part 14) built in throughout: capture work is
strictly serialized (one job at a time, no threading/async), polling
intervals are configurable (config.py defaults are Pi-Zero-conservative),
uploads are size-capped before reading a file into memory, and the spool
itself is size-bounded (see spool.py has_room_for()).
"""

from __future__ import annotations

import logging
import signal
import time
import uuid

from . import camera, config
from .camera_inventory import (
    InventoryRefreshInProgress,
    camera_inventory_cache_status,
    camera_to_inventory_payload,
    inventory_refresh_lock,
    load_camera_inventory_cache,
    write_camera_inventory_cache,
)
from .protocol import AgentProtocolClient, ProtocolError
from .power.runtime import PowerManager, poll_and_execute_power_command, upload_power_state
from .sensors.runtime import EnvironmentalSensorManager, selected_driver_mode
from .sensors.test_command_runtime import poll_and_execute_sensor_test
from .spool import Spool

logger = logging.getLogger("plantlab_edge_agent")

ACK_RETAIN_SECONDS = 7 * 24 * 60 * 60
MAX_IDLE_SLEEP_SECONDS = 1.0


class FatalAgentError(Exception):
    pass


def load_client_and_config() -> tuple[config.EdgeAgentConfig, AgentProtocolClient]:
    cfg = config.read_config()
    if cfg is None:
        raise FatalAgentError('This machine is not configured as a PlantLab edge agent. Run "plantlab node attach <host>" from the coordinator, or write ~/.config/plantlab/edge-agent.json directly.')
    if not cfg.coordinator_url:
        raise FatalAgentError("edge-agent.json is missing coordinatorUrl.")
    token = config.read_credential()
    if not token:
        raise FatalAgentError("PLANTLAB_NODE_CREDENTIAL is not set. Check ~/.config/plantlab/agent.env.")
    return cfg, AgentProtocolClient(cfg.coordinator_url, token)


def camera_capability_enabled(cfg: config.EdgeAgentConfig) -> bool:
    return "camera" in cfg.capabilities


def send_heartbeat(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, sensors: EnvironmentalSensorManager | None = None) -> None:
    info = _platform_info()
    try:
        client.heartbeat(
            info["hostname"],
            cfg.role,
            info["operating_system"],
            info["architecture"],
            cfg.capabilities,
            environment=sensors.health(cfg).to_heartbeat_payload() if sensors else None,
        )
    except ProtocolError as exc:
        logger.warning("Heartbeat failed: %s", exc)


def refresh_camera_inventory(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, reason: str = "requested") -> bool:
    if not camera_capability_enabled(cfg):
        logger.info("Camera inventory refresh skipped: camera capability is disabled.")
        return False

    try:
        with inventory_refresh_lock(cfg.spool_root):
            started = time.monotonic()
            logger.info("Camera inventory refresh started: reason=%s", reason)
            metadata = camera.discover_camera_metadata()
            metadata_at = time.monotonic()
            logger.info("Camera metadata scan completed in %.1f seconds: groups=%d", metadata_at - started, len(metadata))
            cameras = camera.verify_camera_metadata(metadata)
            verified_at_monotonic = time.monotonic()
            logger.info("Verified %d candidate group(s) in %.1f seconds.", len(cameras), verified_at_monotonic - metadata_at)
            payload = [camera_to_inventory_payload(c) for c in cameras]
            client.post_camera_inventory(payload)
            verified_at = _now_iso()
            write_camera_inventory_cache(cfg.spool_root, payload, verified_at)
            logger.info("Camera inventory posted and cached: cameras=%d elapsed=%.1fs", len(payload), time.monotonic() - started)
            return True
    except InventoryRefreshInProgress:
        logger.info("Camera inventory refresh skipped: another refresh is already running.")
        return False
    except ProtocolError as exc:
        logger.warning("Camera inventory report failed: %s", exc)
        return False
    except Exception as exc:
        logger.warning("Camera inventory refresh failed: %s", exc)
        return False


def post_cached_camera_inventory(cfg: config.EdgeAgentConfig, client: AgentProtocolClient) -> bool:
    cache = load_camera_inventory_cache(cfg.spool_root)
    if not cache:
        return False
    try:
        client.post_camera_inventory(cache.cameras)
        logger.info("Posted cached camera inventory: cameras=%d verifiedAt=%s", len(cache.cameras), cache.verified_at)
        return True
    except ProtocolError as exc:
        logger.warning("Cached camera inventory report failed: %s", exc)
        return False


def poll_and_run_job(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, spool: Spool) -> None:
    try:
        job = client.next_job()
    except ProtocolError as exc:
        logger.warning("Job poll failed: %s", exc)
        return
    if job is None:
        return

    if not spool.has_room_for(cfg.max_upload_bytes):
        logger.warning("Spool is at capacity (%d bytes) - skipping job %s until space frees up.", spool.max_spool_bytes, job.id)
        return

    capture_id = str(uuid.uuid4())
    try:
        client.claim_job(job.id, capture_id)
    except ProtocolError as exc:
        logger.warning("Could not claim job %s: %s", job.id, exc)
        return

    output_path = spool.pending_path(capture_id)
    try:
        camera.capture_frame(job.device_path, output_path, width=job.width, height=job.height, input_format=job.input_format)
        spool.record_captured(
            job_id=job.id,
            capture_id=capture_id,
            assignment_id=job.assignment_id,
            capture_source_id=job.capture_source_id,
            local_file_path=output_path,
            captured_at=_now_iso(),
        )
        logger.info("Frame captured to durable spool: job=%s capture=%s", job.id, capture_id)
    except Exception as exc:  # capture/spool failure - report and move on, never crash the loop
        try:
            client.fail_job(job.id, str(exc))
        except ProtocolError:
            pass
        logger.error("Capture job %s failed: %s", job.id, exc)


def maybe_refresh_inventory(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, state: dict) -> bool:
    if not camera_capability_enabled(cfg):
        return False
    try:
        refresh = client.camera_inventory_refresh_request()
    except ProtocolError as exc:
        logger.warning("Inventory refresh check failed: %s", exc)
        return False
    requested_at = refresh.get("requestedAt") if refresh.get("requested") else None
    if not requested_at or not isinstance(requested_at, str):
        return False
    if requested_at == state.get("last_refresh_requested_at"):
        return False
    state["last_refresh_requested_at"] = requested_at
    return refresh_camera_inventory(cfg, client, reason=f"coordinator:{requested_at}")


def maybe_refresh_power_state(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, power: PowerManager, state: dict) -> bool:
    """Mirrors maybe_refresh_inventory() for the "Refresh power state" node
    action - re-uploads outlet state immediately instead of waiting for the
    routine power_state_refresh_interval_seconds cadence."""
    if not power.enabled:
        return False
    try:
        refresh = client.power_state_refresh_request()
    except ProtocolError as exc:
        logger.warning("Power refresh check failed: %s", exc)
        return False
    requested_at = refresh.get("requestedAt") if refresh.get("requested") else None
    if not requested_at or not isinstance(requested_at, str):
        return False
    if requested_at == state.get("last_power_refresh_requested_at"):
        return False
    state["last_power_refresh_requested_at"] = requested_at
    return upload_power_state(cfg, client, power, startup=power.last_state_upload_at <= 0)


def process_uploads(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, spool: Spool) -> None:
    for record in spool.due_uploads():
        active = record
        try:
            active = spool.move_file_for_state(record, "uploading")
            metadata = {
                "captureId": active.capture_id,
                "capturedAt": active.captured_at,
                "captureSourceId": active.capture_source_id,
                "originalFilename": active.local_file_path.split("/")[-1],
                "expectedSha256": active.sha256,
                "expectedByteSize": active.byte_size,
                "mimeType": "image/jpeg",
            }
            client.upload_capture(active.local_file_path, metadata, cfg.max_upload_bytes)
            client.complete_job(active.job_id, active.capture_id)
            active = spool.move_file_for_state(active, "acknowledged")
            spool.mark_acknowledged(active.job_id)
            logger.info("Capture acknowledged: job=%s capture=%s", active.job_id, active.capture_id)
        except Exception as exc:
            try:
                spool.move_file_for_state(active, "failed")
            except Exception:
                pass
            spool.mark_failed(active.job_id, str(exc))
            try:
                client.fail_job(active.job_id, str(exc))
            except ProtocolError:
                pass
            logger.warning("Capture upload failed: job=%s error=%s", active.job_id, exc)


def sample_environment(cfg: config.EdgeAgentConfig, sensors: EnvironmentalSensorManager, spool: Spool) -> None:
    events = sensors.sample_due()
    if not events:
        return
    inserted = spool.record_environment_events([event.to_wire() for event in events])
    if inserted:
        logger.info("Environmental telemetry spooled: %d event(s)", inserted)


def process_environment_uploads(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, sensors: EnvironmentalSensorManager, spool: Spool) -> None:
    if not sensors.upload_due():
        return
    due = spool.due_environment_events(limit=50)
    if not due:
        return
    _upload_environment_records(cfg, client, sensors, spool, due)


def _upload_environment_records(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, sensors: EnvironmentalSensorManager, spool: Spool, records: list) -> None:
    event_ids = [record.event_id for record in records]
    try:
        response = client.post_environment(cfg.node_name, [record.payload() for record in records])
        acknowledged = response.get("acceptedEventIds") if isinstance(response, dict) else None
        ack_ids = [event_id for event_id in acknowledged if isinstance(event_id, str)] if isinstance(acknowledged, list) else event_ids
        spool.mark_environment_acknowledged(ack_ids)
        sensors.mark_uploaded()
        logger.info("Environmental telemetry uploaded: %d event(s)", len(ack_ids))
    except ProtocolError as exc:
        if exc.status == 400 and len(records) > 1:
            logger.warning("Environmental telemetry batch was rejected; isolating %d event(s).", len(records))
            for record in records:
                _upload_environment_records(cfg, client, sensors, spool, [record])
            return
        if exc.status == 400 and len(records) == 1:
            spool.discard_environment_events(event_ids, str(exc))
            logger.warning("Discarded malformed environmental telemetry event %s: %s", event_ids[0], exc)
            return
        spool.mark_environment_failed(event_ids, str(exc))
        logger.warning("Environmental telemetry upload failed: %s", exc)


def run_loop(stop_check=lambda: False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg, client = load_client_and_config()

    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    sensors = EnvironmentalSensorManager.from_config(cfg)
    power = PowerManager(cfg)
    logger.info("PlantLab edge agent starting: coordinator=%s spool=%s", cfg.coordinator_url, cfg.spool_root)
    if cfg.sensors or cfg.power:
        logger.info(
            "Greenhouse hardware config loaded: sensors=%d power=%s sensor_driver=%s",
            len(cfg.sensors),
            cfg.power.provider if cfg.power else "not configured",
            selected_driver_mode(),
        )
    if cfg.sensors and not sensors.runtimes:
        logger.info("No enabled greenhouse environmental sensors are configured.")
    cache_status = camera_inventory_cache_status(cfg.spool_root)
    if camera_capability_enabled(cfg):
        logger.info(
            "Camera inventory cache: %s cameras=%s verifiedAt=%s",
            "valid" if cache_status["valid"] else "missing/invalid",
            cache_status["cameraCount"],
            cache_status["verifiedAt"] or "never",
        )

    stopping = {"value": False}

    def _handle_signal(signum, frame):
        stopping["value"] = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    refresh_state: dict = {}
    now = time.monotonic()
    next_heartbeat_at = now
    next_job_poll_at = now
    next_refresh_poll_at = now if camera_capability_enabled(cfg) else float("inf")
    next_sensor_sample_at = now if sensors.runtimes else float("inf")
    next_environment_upload_at = now
    next_capture_upload_at = now
    next_power_command_poll_at = now if power.enabled else float("inf")
    next_power_state_refresh_at = now if power.enabled else float("inf")
    next_power_refresh_check_at = now if power.enabled else float("inf")
    next_sensor_test_poll_at = now if cfg.sensors else float("inf")
    next_cleanup_at = now + max(60, cfg.spool_cleanup_interval_seconds)
    try:
        while not stopping["value"] and not stop_check():
            now = time.monotonic()
            if now >= next_heartbeat_at:
                send_heartbeat(cfg, client, sensors)
                next_heartbeat_at = now + cfg.heartbeat_interval_seconds
            if now >= next_refresh_poll_at:
                maybe_refresh_inventory(cfg, client, refresh_state)
                next_refresh_poll_at = now + max(1, cfg.camera_refresh_poll_interval_seconds)
            if now >= next_sensor_sample_at:
                sample_environment(cfg, sensors, spool)
                next_sensor_sample_at = now + max(1, cfg.sensor_sample_interval_seconds) if sensors.runtimes else float("inf")
            if now >= next_job_poll_at:
                poll_and_run_job(cfg, client, spool)
                next_job_poll_at = now + max(1, cfg.poll_interval_seconds)
            if now >= next_capture_upload_at:
                process_uploads(cfg, client, spool)
                next_capture_upload_at = now + max(1, cfg.poll_interval_seconds)
            if now >= next_power_state_refresh_at:
                upload_power_state(cfg, client, power, startup=power.last_state_upload_at <= 0)
                next_power_state_refresh_at = now + max(1, cfg.power_state_refresh_interval_seconds)
            if now >= next_power_command_poll_at:
                poll_and_execute_power_command(cfg, client, power)
                next_power_command_poll_at = now + max(1, cfg.power_command_poll_interval_seconds)
            if now >= next_power_refresh_check_at:
                maybe_refresh_power_state(cfg, client, power, refresh_state)
                next_power_refresh_check_at = now + max(1, cfg.power_command_poll_interval_seconds)
            if now >= next_sensor_test_poll_at:
                poll_and_execute_sensor_test(cfg, client)
                next_sensor_test_poll_at = now + max(1, cfg.sensor_test_poll_interval_seconds)
            if now >= next_environment_upload_at:
                process_environment_uploads(cfg, client, sensors, spool)
                next_environment_upload_at = now + max(1, cfg.environment_upload_interval_seconds)
            if now >= next_cleanup_at:
                try:
                    spool.cleanup_acknowledged(ACK_RETAIN_SECONDS)
                    spool.cleanup_acknowledged_environment(ACK_RETAIN_SECONDS)
                except Exception:
                    pass
                next_cleanup_at = now + max(60, cfg.spool_cleanup_interval_seconds)

            next_due = min(
                next_heartbeat_at,
                next_job_poll_at,
                next_refresh_poll_at,
                next_sensor_sample_at,
                next_environment_upload_at,
                next_capture_upload_at,
                next_power_command_poll_at,
                next_power_state_refresh_at,
                next_power_refresh_check_at,
                next_sensor_test_poll_at,
                next_cleanup_at,
            )
            sleep_for = max(0.0, min(MAX_IDLE_SLEEP_SECONDS, next_due - time.monotonic()))
            if sleep_for > 0:
                time.sleep(sleep_for)
    finally:
        power.close()
        sensors.close()
        spool.close()
    logger.info("PlantLab edge agent stopped")


def _platform_info() -> dict:
    from .protocol import platform_info

    return platform_info()


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
