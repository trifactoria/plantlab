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
from .protocol import AgentProtocolClient, ProtocolError
from .spool import Spool

logger = logging.getLogger("plantlab_edge_agent")

ACK_RETAIN_SECONDS = 7 * 24 * 60 * 60


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


def run_heartbeat_and_inventory(cfg: config.EdgeAgentConfig, client: AgentProtocolClient) -> None:
    info = _platform_info()
    try:
        client.heartbeat(info["hostname"], cfg.role, info["operating_system"], info["architecture"], cfg.capabilities)
    except ProtocolError as exc:
        logger.warning("Heartbeat failed: %s", exc)

    try:
        cameras = camera.discover_cameras()
        payload = [
            {
                "stableId": c.stable_id or f"device:{c.device}",
                "devicePath": c.device,
                "name": c.name,
                # A real, ffmpeg-verified capture (Part 5), not just V4L2
                # metadata claiming "Video Capture" support - metadata alone
                # is what let a Raspberry Pi's non-camera hardware codec/ISP
                # devices (each its own stable-ID group) show up as if they
                # were selectable cameras.
                "available": c.verified_capture is True,
                "formats": [],
            }
            for c in cameras
        ]
        client.post_camera_inventory(payload)
    except ProtocolError as exc:
        logger.warning("Camera inventory report failed: %s", exc)


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


def run_loop(stop_check=lambda: False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg, client = load_client_and_config()

    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    logger.info("PlantLab edge agent starting: coordinator=%s spool=%s", cfg.coordinator_url, cfg.spool_root)

    stopping = {"value": False}

    def _handle_signal(signum, frame):
        stopping["value"] = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    last_heartbeat = 0.0
    try:
        while not stopping["value"] and not stop_check():
            now = time.monotonic()
            if now - last_heartbeat >= cfg.heartbeat_interval_seconds:
                run_heartbeat_and_inventory(cfg, client)
                last_heartbeat = now
            poll_and_run_job(cfg, client, spool)
            process_uploads(cfg, client, spool)
            try:
                spool.cleanup_acknowledged(ACK_RETAIN_SECONDS)
            except Exception:
                pass
            time.sleep(cfg.poll_interval_seconds)
    finally:
        spool.close()
    logger.info("PlantLab edge agent stopped")


def _platform_info() -> dict:
    from .protocol import platform_info

    return platform_info()


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
