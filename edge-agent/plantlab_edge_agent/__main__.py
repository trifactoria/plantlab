"""CLI entry point: ``python3 -m plantlab_edge_agent <command>``.

The systemd service (see systemd/plantlab-edge-agent.service.template)
only ever runs ``run`` - the other subcommands are for manual debugging and
for install.sh's own post-install verification. Manual test captures don't
need a dedicated subcommand: `plantlab camera attach`/`plantlab capture
test` on the coordinator create a normal AgentCaptureJob row, which the
running `run` loop picks up through the same GET /api/agents/jobs/next
poll any other node's agent uses - see docs/AGENT_PROTOCOL.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from . import agent, camera, config
from .camera_inventory import camera_inventory_cache_status, inventory_refresh_running
from .protocol import AGENT_RUNTIME, AGENT_VERSION, PROTOCOL_VERSION, AgentProtocolClient, ProtocolError, platform_info, request_json
from .power.base import PowerDriverError
from .power.dependencies import edge_python_info, inspect_imports, inspect_kasa_pin
from .power.kasa import KasaPowerDriver, dependency_available as kasa_dependency_available
from .power.models import WATER_MAX_PULSE_SECONDS
from .power.runtime import PowerManager
from .sensors import probe as sensor_probe
from .sensors.base import CLASSIFICATION_ACCEPTED, RawEnvironmentalSample, SensorDriverError
from .sensors.dht22 import DHT22PigpioDriver
from .sensors.mock import DriverUnavailableError
from .sensors.runtime import DRIVER_MODE_DHT22, DRIVER_MODE_DISABLED, DRIVER_MODE_ENV, DRIVER_MODE_MOCK, selected_driver_mode
from .sensors.validation import EnvironmentalSampleValidator

try:
    from . import _install_meta
except Exception:  # pragma: no cover - absent in source checkouts before install.sh writes it
    _install_meta = None


def _load_config_safely():
    try:
        return config.read_config(), None
    except Exception as exc:
        return None, str(exc)


def sensor_driver_mode_summary() -> dict[str, str | None]:
    current = os.environ.get(DRIVER_MODE_ENV)
    configured = _configured_sensor_driver_mode()
    service_effective = _service_effective_sensor_driver_mode()
    resolved = current or service_effective or configured or selected_driver_mode()
    return {
        "configured": configured,
        "serviceEffective": service_effective,
        "currentProcess": current,
        "resolved": resolved,
    }


def _configured_sensor_driver_mode() -> str | None:
    dropin_dir = _systemd_user_dir() / "plantlab-edge-agent.service.d"
    if not dropin_dir.exists():
        return None
    found: str | None = None
    for path in sorted(dropin_dir.glob("*.conf")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        value = _extract_systemd_environment_value(text, DRIVER_MODE_ENV)
        if value:
            found = value
    return found


def _service_effective_sensor_driver_mode() -> str | None:
    try:
        result = subprocess.run(
            ["systemctl", "--user", "show", "plantlab-edge-agent.service", "-p", "Environment", "--value"],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return _extract_systemd_environment_value(result.stdout, DRIVER_MODE_ENV)


def _extract_systemd_environment_value(text: str, key: str) -> str | None:
    for raw_line in text.replace("\0", "\n").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("Environment="):
            line = line[len("Environment=") :]
        for token in _split_systemd_environment(line):
            if token.startswith(f"{key}="):
                return token.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def _split_systemd_environment(value: str) -> list[str]:
    try:
        import shlex

        return shlex.split(value)
    except Exception:
        return value.split()


def _config_summary(cfg: config.EdgeAgentConfig | None) -> dict:
    token = config.read_credential()
    greenhouse_secret_path = config.CONFIG_DIR / "greenhouse.env"
    sensor_modes = sensor_driver_mode_summary()
    return {
        "configPath": str(config.CONFIG_PATH),
        "credentialPath": str(config.CREDENTIAL_PATH),
        "nodeName": cfg.node_name if cfg else None,
        "role": cfg.role if cfg else None,
        "coordinatorUrl": cfg.coordinator_url if cfg else None,
        "spoolRoot": cfg.spool_root if cfg else str(config.DEFAULT_SPOOL_ROOT),
        "capabilities": cfg.capabilities if cfg else [],
        "heartbeatIntervalSeconds": cfg.heartbeat_interval_seconds if cfg else None,
        "pollIntervalSeconds": cfg.poll_interval_seconds if cfg else None,
        "powerCommandPollIntervalSeconds": cfg.power_command_poll_interval_seconds if cfg else None,
        "powerStateRefreshIntervalSeconds": cfg.power_state_refresh_interval_seconds if cfg else None,
        "maxSpoolBytes": cfg.max_spool_bytes if cfg else None,
        "maxUploadBytes": cfg.max_upload_bytes if cfg else None,
        "credentialPresent": bool(token),
        "credentialLength": len(token) if token else 0,
        "greenhouseSecretPath": str(greenhouse_secret_path),
        "greenhouseSecretPresent": greenhouse_secret_path.exists(),
        "sensorDriverMode": sensor_modes["resolved"],
        "sensorDriverModes": sensor_modes,
        "sensors": [
            {
                "key": sensor.key,
                "name": sensor.name,
                "type": sensor.type,
                "gpio": sensor.gpio,
                "placement": sensor.placement,
                "enabled": sensor.enabled,
            }
            for sensor in (cfg.sensors if cfg else [])
        ],
        "power": {"provider": cfg.power.provider, "host": cfg.power.host, "outlets": dict(cfg.power.outlets)} if cfg and cfg.power else None,
        "cameraCapabilityEnabled": "camera" in cfg.capabilities if cfg else False,
        "cameraRefreshPollIntervalSeconds": cfg.camera_refresh_poll_interval_seconds if cfg else None,
        "cameraInventoryCache": camera_inventory_cache_status(cfg.spool_root if cfg else str(config.DEFAULT_SPOOL_ROOT)),
        "cameraInventoryRefreshRunning": inventory_refresh_running(cfg.spool_root if cfg else str(config.DEFAULT_SPOOL_ROOT)),
        "cameraSubprocessActive": _camera_subprocess_active(),
    }


def _spool_ok(spool_root: str) -> tuple[bool, str]:
    root = Path(spool_root)
    try:
        root.mkdir(parents=True, exist_ok=True)
        marker = root / ".plantlab-write-test"
        marker.write_text("ok", encoding="utf-8")
        marker.unlink(missing_ok=True)
        for subdir in ("spool/pending", "spool/uploading", "spool/acknowledged", "spool/failed", "logs"):
            (root / subdir).mkdir(parents=True, exist_ok=True)
        return True, "writable"
    except Exception as exc:
        return False, str(exc)


def run_self_check(send_heartbeat: bool = True) -> dict:
    checks = []
    cfg, config_error = _load_config_safely()

    def add(name: str, ok: bool, detail: str):
        checks.append({"name": name, "ok": ok, "detail": detail})

    add("config-file", config.CONFIG_PATH.exists(), str(config.CONFIG_PATH))
    if config_error:
        add("config-json", False, config_error)
    elif cfg:
        add("config-json", True, "parsed")
        for problem in config.validate_config(cfg):
            add("config-valid", False, problem)
        if not config.validate_config(cfg):
            add("config-valid", True, "required values present")
    else:
        add("config-json", False, "edge-agent.json is missing")

    token = config.read_credential()
    add("credential-file", config.CREDENTIAL_PATH.exists(), str(config.CREDENTIAL_PATH))
    add("credential-variable", bool(token), "PLANTLAB_NODE_CREDENTIAL present" if token else "PLANTLAB_NODE_CREDENTIAL missing or empty")

    if cfg:
        spool_writable, spool_detail = _spool_ok(cfg.spool_root)
        add("spool", spool_writable, spool_detail)
        enabled_sensors = [sensor for sensor in cfg.sensors if sensor.enabled]
        mode = selected_driver_mode()
        if enabled_sensors:
            if mode not in (DRIVER_MODE_MOCK, DRIVER_MODE_DHT22, DRIVER_MODE_DISABLED, "unavailable"):
                add("sensor-driver-mode", False, f'unsupported mode "{mode}"')
            elif mode == DRIVER_MODE_DHT22:
                hardware = sensor_probe.collect_probe(cfg)
                add("sensor-driver-mode", True, "dht22")
                add("dht22-backend", bool(hardware.get("backendReady")), str(hardware.get("backendReadinessDetail") or "unknown"))
            elif mode == DRIVER_MODE_MOCK:
                add("sensor-driver-mode", True, "mock")
            elif mode == DRIVER_MODE_DISABLED:
                add("sensor-driver-mode", False, "disabled while enabled sensors are configured")
            else:
                add("sensor-driver-mode", False, f"{DRIVER_MODE_ENV} is not set")
    else:
        add("spool", False, "configuration unavailable")

    try:
        import plantlab_edge_agent.agent  # noqa: F401
        import plantlab_edge_agent.camera  # noqa: F401
        import plantlab_edge_agent.config  # noqa: F401
        import plantlab_edge_agent.protocol  # noqa: F401
        add("python-imports", True, "plantlab_edge_agent imports")
    except Exception as exc:
        add("python-imports", False, str(exc))

    if cfg and cfg.coordinator_url:
        try:
            request_json(f"{cfg.coordinator_url.rstrip('/')}/api/node-info", token or "", method="GET", timeout=5)
            add("coordinator-node-info", True, "reachable")
        except ProtocolError as exc:
            add("coordinator-node-info", False, str(exc))
    else:
        add("coordinator-node-info", False, "coordinatorUrl missing")

    if cfg and token:
        client = AgentProtocolClient(cfg.coordinator_url, token)
        try:
            client.credential_check()
            add("credential-check", True, "accepted")
        except ProtocolError as exc:
            add("credential-check", False, str(exc))
        if send_heartbeat:
            info = platform_info()
            try:
                client.heartbeat(info["hostname"], cfg.role, info["operating_system"], info["architecture"], cfg.capabilities)
                add("heartbeat", True, "accepted")
            except ProtocolError as exc:
                add("heartbeat", False, str(exc))
    else:
        add("credential-check", False, "configuration or credential missing")
        if send_heartbeat:
            add("heartbeat", False, "configuration or credential missing")

    return {"ok": all(item["ok"] for item in checks), "summary": _config_summary(cfg), "checks": checks}


def print_check_report(report: dict) -> None:
    for item in report["checks"]:
        print(f"{'PASS' if item['ok'] else 'FAIL'}: {item['name']}: {item['detail']}")
    print("")
    print("Overall:", "healthy" if report["ok"] else "problems detected")


def cmd_run(_args: argparse.Namespace) -> int:
    try:
        agent.run_loop()
    except agent.FatalAgentError as exc:
        print(f"Fatal PlantLab edge agent error: {exc}", file=sys.stderr)
        return 1
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    cfg, config_error = _load_config_safely()
    summary = _config_summary(cfg)
    print(f"PlantLab Edge Agent {AGENT_VERSION}")
    print(f"Runtime: {AGENT_RUNTIME}")
    print(f"Protocol: {PROTOCOL_VERSION}")
    print(f"Config: {summary['configPath']}")
    if config_error:
        print(f"Config error: {config_error}")
    print(f"Node: {summary['nodeName'] or '(not configured)'}")
    print(f"Role: {summary['role'] or '(not configured)'}")
    print(f"Coordinator: {summary['coordinatorUrl'] or '(not configured)'}")
    print(f"Spool: {summary['spoolRoot']}")
    print(f"Credential present: {'yes' if summary['credentialPresent'] else 'no'}")
    return 0 if cfg and not config.validate_config(cfg) and summary["credentialPresent"] else 1


def cmd_doctor(_args: argparse.Namespace) -> int:
    report = run_self_check(send_heartbeat=True)
    print_check_report(report)
    return 0 if report["ok"] else 1


def cmd_config_show(args: argparse.Namespace) -> int:
    cfg, config_error = _load_config_safely()
    summary = _config_summary(cfg)
    if args.json:
        print(json.dumps({"error": config_error, **summary}, indent=2))
        return 0 if cfg and not config_error else 1
    if config_error:
        print(f"Config error: {config_error}", file=sys.stderr)
    print(f"Config path: {summary['configPath']}")
    print(f"Node name: {summary['nodeName'] or '(missing)'}")
    print(f"Role: {summary['role'] or '(missing)'}")
    print(f"Coordinator URL: {summary['coordinatorUrl'] or '(missing)'}")
    print(f"Spool root: {summary['spoolRoot']}")
    print(f"Capabilities: {', '.join(summary['capabilities']) if summary['capabilities'] else '(none)'}")
    print(f"Configured sensors: {len(summary['sensors'])}")
    for sensor in summary["sensors"]:
        print(f"  - {sensor['key']}: {sensor['name']}, {sensor['type']}, BCM GPIO {sensor['gpio']}, {sensor['placement'] or 'no placement'}, {'enabled' if sensor['enabled'] else 'disabled'}")
    if summary["power"]:
        print(f"Power provider: {summary['power']['provider']}")
        print(f"Power host: {summary['power']['host']}")
        outlets = summary["power"]["outlets"]
        print(f"Power outlets: {', '.join(f'{key}={value}' for key, value in outlets.items()) if outlets else '(none)'}")
    else:
        print("Power: not configured")
    modes = summary["sensorDriverModes"]
    print(f"Configured sensor driver mode: {modes['configured'] or 'none'}")
    print(f"Service-effective sensor driver mode: {modes['serviceEffective'] or 'unknown'}")
    print(f"Current shell override: {modes['currentProcess'] or 'none'}")
    print(f"Sensor driver mode: {summary['sensorDriverMode']}")
    cache = summary["cameraInventoryCache"]
    print(f"Camera capability enabled: {'yes' if summary['cameraCapabilityEnabled'] else 'no'}")
    print(f"Cached camera inventory: {'present' if cache['valid'] else 'missing'} ({cache['cameraCount']} cameras)")
    print(f"Cached inventory age: {int(cache['ageSeconds']) if cache['ageSeconds'] is not None else '(unknown)'} seconds")
    print(f"Last verified inventory time: {cache['verifiedAt'] or '(never)'}")
    print(f"Inventory refresh currently running: {'yes' if summary['cameraInventoryRefreshRunning'] else 'no'}")
    print(f"Camera refresh poll interval: {summary['cameraRefreshPollIntervalSeconds'] or '(missing)'} seconds")
    print(f"Camera subprocess currently active: {'yes' if summary['cameraSubprocessActive'] else 'no'}")
    print(f"Greenhouse secret file: {'present' if summary['greenhouseSecretPresent'] else 'missing'} ({summary['greenhouseSecretPath']})")
    print(f"Heartbeat interval: {summary['heartbeatIntervalSeconds'] or '(missing)'}")
    print(f"Poll interval: {summary['pollIntervalSeconds'] or '(missing)'}")
    print(f"Power command poll interval: {summary['powerCommandPollIntervalSeconds'] or '(missing)'} seconds")
    print(f"Power state refresh interval: {summary['powerStateRefreshIntervalSeconds'] or '(missing)'} seconds")
    print(f"Credential present: {'yes' if summary['credentialPresent'] else 'no'}")
    if summary["credentialPresent"]:
        print(f"Credential length: {summary['credentialLength']}")
    return 0 if cfg and not config_error else 1


def cmd_heartbeat(_args: argparse.Namespace) -> int:
    try:
        cfg, client = agent.load_client_and_config()
    except agent.FatalAgentError as exc:
        print(f"Fatal PlantLab edge agent error: {exc}", file=sys.stderr)
        return 1
    info = platform_info()
    try:
        result = client.heartbeat(info["hostname"], cfg.role, info["operating_system"], info["architecture"], cfg.capabilities)
    except ProtocolError as exc:
        print(f"Heartbeat failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


def cmd_credential_check(_args: argparse.Namespace) -> int:
    try:
        _cfg, client = agent.load_client_and_config()
    except agent.FatalAgentError as exc:
        print(f"Fatal PlantLab edge agent error: {exc}", file=sys.stderr)
        return 1
    try:
        result = client.credential_check()
    except ProtocolError as exc:
        print(f"Credential check failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


def cmd_inventory(_args: argparse.Namespace) -> int:
    cameras = camera.discover_cameras()
    print(json.dumps([_camera_to_dict(c) for c in cameras], indent=2))
    return 0


def _camera_to_dict(c: camera.CameraInfo) -> dict:
    return {
        "name": c.name,
        "stableId": c.stable_id,
        "legacyStableId": c.legacy_stable_id,
        "physicalCamera": c.stable_id or f"device:{c.device}",
        "verifiedPrimaryDevice": c.device,
        "vendorId": c.vendor_id,
        "productId": c.product_id,
        "serial": c.serial,
        "physicalPath": c.physical_path,
        "usbPath": c.usb_path,
        "usbPort": c.usb_port,
        "supportsCapture": c.supports_capture,
        "available": c.verified_capture,
        "verifiedCapture": c.verified_capture,
        "verifiedProbeMode": c.verified_format,
        "captureProbeError": c.capture_probe_error,
        "formatsStatus": c.formats_status,
        "formatsError": c.formats_error,
        "formats": c.formats,
        "alternateDevices": [
            {
                "device": device,
                "probeFailure": c.alternate_probe_errors.get(device),
            }
            for device in c.alternate_devices
        ],
    }


def _format_label(pixel_format: str) -> str:
    normalized = (pixel_format or "").lower()
    if normalized == "mjpeg":
        return "MJPEG"
    if normalized == "yuyv422":
        return "YUYV"
    return normalized.upper()


def cmd_camera_list(args: argparse.Namespace) -> int:
    cameras = camera.discover_cameras()
    if args.json:
        print(json.dumps([_camera_to_dict(c) for c in cameras], indent=2))
        return 0
    if not cameras:
        print("No cameras discovered.")
        return 0
    for idx, c in enumerate(cameras, start=1):
        print(f"{idx}. {c.name or 'Unknown camera'}")
        print(f"   Physical camera: {c.stable_id or f'device:{c.device}'}")
        print(f"   Primary device: {c.device}")
        if c.usb_port or c.physical_path:
            print(f"   USB path: {c.usb_port or c.physical_path}")
        print(f"   Stable ID: {c.stable_id or '(none)'}")
        if c.legacy_stable_id and c.legacy_stable_id != c.stable_id:
            print(f"   Legacy stable ID: {c.legacy_stable_id}")
        print(f"   Capture-capable: {'yes' if c.supports_capture else 'no'}")
        print(f"   Verified capture: {'yes' if c.verified_capture else 'no'}")
        if c.verified_format:
            print(
                "   Verified probe mode: "
                f"{_format_label(str(c.verified_format.get('pixelFormat')))} "
                f"{c.verified_format.get('width')}x{c.verified_format.get('height')}"
            )
        if c.capture_probe_error:
            print(f"   Probe error: {c.capture_probe_error}")
        if c.alternate_devices:
            print("   Alternate devices:")
            for device in c.alternate_devices:
                failure = c.alternate_probe_errors.get(device)
                print(f"     {device}{f' - probe failed: {failure}' if failure else ''}")
        if args.verbose:
            print(f"   Formats status: {c.formats_status}{f' ({c.formats_error})' if c.formats_error else ''}")
            if c.formats:
                print("   Advertised modes:")
                for fmt in c.formats:
                    resolutions = fmt.get("resolutions") if isinstance(fmt, dict) else []
                    for resolution in resolutions if isinstance(resolutions, list) else []:
                        if not isinstance(resolution, dict):
                            continue
                        frame_rates = resolution.get("frameRates")
                        fps = f" @ {', '.join(str(rate) for rate in frame_rates)}" if isinstance(frame_rates, list) and frame_rates else ""
                        print(f"     {_format_label(str(fmt.get('pixelFormat')))} {resolution.get('width')}x{resolution.get('height')}{fps}")
            else:
                print("   Advertised modes: (none)")
    return 0


def cmd_camera_refresh(_args: argparse.Namespace) -> int:
    try:
        cfg, client = agent.load_client_and_config()
    except agent.FatalAgentError as exc:
        print(f"Fatal PlantLab edge agent error: {exc}", file=sys.stderr)
        return 1
    ok = agent.refresh_camera_inventory(cfg, client, reason="local-cli")
    return 0 if ok else 1


def _camera_subprocess_active() -> bool:
    try:
        result = subprocess.run(["pgrep", "-f", "ffmpeg|v4l2-ctl|udevadm"], capture_output=True, text=True, timeout=2)
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def _load_power_config() -> tuple[config.EdgeAgentConfig | None, str | None]:
    cfg, config_error = _load_config_safely()
    if config_error or cfg is None:
        return None, config_error or "edge-agent.json is missing"
    if not cfg.power:
        return None, "power is not configured"
    return cfg, None


def _power_probe_payload(cfg: config.EdgeAgentConfig | None) -> dict:
    secrets = config.read_greenhouse_secrets()
    kasa_pin = inspect_kasa_pin()
    edge_python = edge_python_info()
    payload = {
        "edgePython": edge_python,
        "dependencyImports": inspect_imports(),
        "kasaDependency": kasa_pin.to_dict(),
        "provider": cfg.power.provider if cfg and cfg.power else None,
        "host": cfg.power.host if cfg and cfg.power else None,
        "credentialFile": {
            "path": str(config.GREENHOUSE_SECRET_PATH),
            "present": config.GREENHOUSE_SECRET_PATH.exists(),
            "hasKasaUsername": bool(secrets.get("KASA_USERNAME")),
            "hasKasaPassword": bool(secrets.get("KASA_PASSWORD")),
        },
        "driverImportReady": kasa_pin.status == "ready",
        "connectivity": "not-attempted",
        "dhcpReservationWarning": None,
        "authentication": "not-attempted",
        "device": None,
        "encryption": None,
        "loginVersion": None,
        "configuredOutlets": dict(cfg.power.outlets) if cfg and cfg.power else {},
        "outlets": [],
        "missingAliases": [],
        "ready": False,
        "errorCode": None,
        "errorMessage": None,
    }
    if not cfg or not cfg.power:
        payload["errorCode"] = "power-configuration-invalid"
        payload["errorMessage"] = "Power is not configured."
        return payload
    payload["dhcpReservationWarning"] = "PlantLab expects the configured Kasa host to remain stable. Reserve this address in the router's DHCP settings."
    payload["connectivity"] = _classify_kasa_connectivity(cfg.power.host)
    driver = KasaPowerDriver(cfg.power.host, secrets.get("KASA_USERNAME", ""), secrets.get("KASA_PASSWORD", ""), cfg.power.outlets)
    try:
        driver.connect()
        states = driver.list_outlets()
        payload["authentication"] = "successful"
        payload["device"] = driver.detected_model
        payload["encryption"] = driver.detected_encryption
        payload["loginVersion"] = driver.detected_login_version
        payload["outlets"] = [
            {
                "key": key,
                "providerAlias": alias,
                "actualState": states.get(key),
                "available": key in states,
            }
            for key, alias in cfg.power.outlets.items()
        ]
        payload["missingAliases"] = [alias for key, alias in cfg.power.outlets.items() if key not in states]
        payload["ready"] = len(payload["missingAliases"]) == 0
    except PowerDriverError as exc:
        payload["authentication"] = "failed" if exc.code == "power-authentication-failed" else "unknown"
        payload["errorCode"] = exc.code
        payload["errorMessage"] = exc.safe_message
    finally:
        driver.close()
    return payload


def _classify_kasa_connectivity(host: str, port: int = 9999, timeout_seconds: float = 1.5) -> str:
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return "tcp-connectable"
    except socket.timeout:
        return "connection-timeout"
    except ConnectionRefusedError:
        return "connection-refused"
    except socket.gaierror:
        return "host-unreachable"
    except OSError as exc:
        message = str(exc).lower()
        if "unreachable" in message or "no route" in message or "network is down" in message:
            return "host-unreachable"
        if "timed out" in message or "timeout" in message:
            return "connection-timeout"
        if "refused" in message:
            return "connection-refused"
        return "unknown"


def cmd_power_probe(args: argparse.Namespace) -> int:
    cfg, config_error = _load_config_safely()
    payload = _power_probe_payload(cfg if not config_error else None)
    if config_error:
        payload["errorCode"] = "power-configuration-invalid"
        payload["errorMessage"] = config_error
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        edge_python = payload["edgePython"]
        kasa_dep = payload["kasaDependency"]
        print(f"Edge Python: {edge_python.get('executable') or '(unknown)'}")
        if edge_python.get("venvPath"):
            print(f"Venv path: {edge_python['venvPath']}")
        print("Kasa dependency:")
        print(f"  source: {kasa_dep.get('source_type') or '(unknown)'}")
        print(f"  repository: {kasa_dep.get('repository') or '(none)'}")
        print(f"  commit: {kasa_dep.get('commit') or '(none)'}")
        print(f"  status: {kasa_dep.get('status')}")
        if kasa_dep.get("import_path"):
            print(f"  import path: {kasa_dep['import_path']}")
        print(f"Provider: {payload['provider'] or '(not configured)'}")
        print(f"Host: {payload['host'] or '(none)'}")
        print(f"Connectivity: {payload['connectivity']}")
        cred = payload["credentialFile"]
        print(f"Credential file: {'present' if cred['present'] else 'missing'}")
        print(f"Required credential keys: {'present' if cred['hasKasaUsername'] and cred['hasKasaPassword'] else 'missing'}")
        print(f"Driver: {'ready' if payload['driverImportReady'] else 'missing'}")
        if payload["device"]:
            print(f"Device: {payload['device']}")
        if payload["encryption"] or payload["loginVersion"]:
            print(f"Transport: {payload['encryption'] or 'unknown'} login {payload['loginVersion'] or 'unknown'}")
        print(f"Authentication: {payload['authentication']}")
        if payload.get("dhcpReservationWarning"):
            print(f"Warning: {payload['dhcpReservationWarning']}")
        if payload["errorCode"] == "power-host-unreachable":
            print(f"Configured Kasa host {payload['host']} is unreachable.")
            print("Verify the strip is online and that its DHCP reservation has not changed.")
        for outlet in payload["outlets"]:
            state = "ON" if outlet["actualState"] is True else "OFF" if outlet["actualState"] is False else "UNKNOWN"
            print(f"{outlet['key']:6} -> {outlet['providerAlias']:20} {state}")
        if payload["ready"]:
            print("PASS: all configured outlets resolved")
        else:
            print(f"FAIL: {payload['errorMessage'] or 'one or more configured outlets are unavailable'}")
    return 0 if payload["ready"] else 1


def cmd_power_status(_args: argparse.Namespace) -> int:
    cfg, error = _load_power_config()
    if error or cfg is None:
        print(f"Power status unavailable: {error}", file=sys.stderr)
        return 1
    manager = PowerManager(cfg)
    try:
        states = manager.refresh_states()
        for state in states:
            actual = "ON" if state.actual_state is True else "OFF" if state.actual_state is False else "UNKNOWN"
            available = "available" if state.available else f"unavailable ({state.last_error_code or 'unknown'})"
            print(f"{state.key:6} -> {state.provider_alias:20} {actual} [{available}]")
        return 0 if all(state.available for state in states) else 1
    finally:
        manager.close()


def cmd_power_on_off(args: argparse.Namespace) -> int:
    cfg, error = _load_power_config()
    if error or cfg is None:
        print(f"Power command unavailable: {error}", file=sys.stderr)
        return 1
    if args.outlet_key == "water" and args.action == "on":
        print("Water outlets do not permit unbounded ON commands. Use: plantlab-edge power pulse water --seconds N", file=sys.stderr)
        return 1
    manager = PowerManager(cfg)
    try:
        result = manager._set(args.outlet_key, args.action == "on")
        if not result.ok:
            print(f"FAIL: {result.error_code}: {result.error_message}", file=sys.stderr)
            return 1
        print(f"PASS: {args.outlet_key} verified {'ON' if result.actual_state else 'OFF'}")
        return 0
    finally:
        manager.close()


def cmd_power_pulse(args: argparse.Namespace) -> int:
    cfg, error = _load_power_config()
    if error or cfg is None:
        print(f"Power command unavailable: {error}", file=sys.stderr)
        return 1
    if args.outlet_key != "water":
        print("Pulse is currently supported only for the water outlet.", file=sys.stderr)
        return 1
    if args.seconds <= 0 or args.seconds > WATER_MAX_PULSE_SECONDS:
        print(f"--seconds must be from 1 to {WATER_MAX_PULSE_SECONDS}.", file=sys.stderr)
        return 1
    manager = PowerManager(cfg)
    try:
        result = manager._pulse("water", args.seconds)
        if not result.ok:
            print(f"FAIL: {result.error_code}: {result.error_message}", file=sys.stderr)
            return 1
        print(f"PASS: water pulsed for {args.seconds} second(s) and verified OFF")
        return 0
    finally:
        manager.close()


def cmd_sensor_probe(args: argparse.Namespace) -> int:
    cfg, config_error = _load_config_safely()
    if config_error and not args.json:
        print(f"Config error: {config_error}", file=sys.stderr)
    try:
        payload = sensor_probe.collect_probe(cfg)
        if config_error:
            payload["configError"] = config_error
    except Exception as exc:
        payload = {"error": str(exc), "selectedDriverMode": selected_driver_mode()}
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"Sensor probe failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        sensor_probe.print_probe(payload)
    return 0


def _find_sensor(cfg: config.EdgeAgentConfig, key: str) -> config.GreenhouseSensorConfig | None:
    for sensor in cfg.sensors:
        if sensor.key == key:
            return sensor
    return None


def cmd_sensor_test(args: argparse.Namespace) -> int:
    if args.attempts < 1:
        print("--attempts must be at least 1.", file=sys.stderr)
        return 1
    if args.interval < 0:
        print("--interval must be 0 or greater.", file=sys.stderr)
        return 1
    cfg, config_error = _load_config_safely()
    if config_error or cfg is None:
        print(f"Config error: {config_error or 'edge-agent.json is missing'}", file=sys.stderr)
        return 1
    sensor = _find_sensor(cfg, args.sensor_key)
    if sensor is None:
        print(f'Unknown sensor "{args.sensor_key}".', file=sys.stderr)
        return 1
    if not sensor.enabled:
        print(f'Sensor "{sensor.key}" is disabled.', file=sys.stderr)
        return 1
    if sensor.type != "dht22":
        print(f'Sensor "{sensor.key}" has unsupported type "{sensor.type}" for this test command.', file=sys.stderr)
        return 1

    print(f"Testing sensor: {sensor.key}")
    print(f"Type: {sensor.type}")
    print(f"BCM GPIO: {sensor.gpio}")
    print(f"Placement: {sensor.placement or '(none)'}")
    print("Backend: pigpio")

    driver = DHT22PigpioDriver(sensor)
    validator = EnvironmentalSampleValidator(sensor)
    accepted: list[RawEnvironmentalSample] = []
    try:
        for attempt in range(1, args.attempts + 1):
            try:
                raw = driver.read()
            except DriverUnavailableError as exc:
                print(f"Attempt {attempt}/{args.attempts}: {getattr(exc, 'code', 'driver-unavailable')} - {exc}")
            except SensorDriverError as exc:
                print(f"Attempt {attempt}/{args.attempts}: {exc.code} - {exc.safe_message}")
            except Exception as exc:
                if args.verbose:
                    print(f"Attempt {attempt}/{args.attempts}: sensor-read-error - {type(exc).__name__}: {exc}")
                else:
                    print(f"Attempt {attempt}/{args.attempts}: sensor-read-error - sensor driver read failed")
            else:
                events = validator.evaluate(raw)
                classification = events[-1].classification if events else "unknown"
                detail = ""
                diagnostic = events[-1].diagnostic_code if events else None
                if diagnostic:
                    detail = f" ({diagnostic})"
                temp = raw.temperature_c
                humidity = raw.humidity_pct
                if isinstance(temp, (int, float)) and isinstance(humidity, (int, float)):
                    print(f"Attempt {attempt}/{args.attempts}: {temp:.1f} C, {humidity:.1f}% RH - {classification}{detail}")
                else:
                    print(f"Attempt {attempt}/{args.attempts}: missing value - {classification}{detail}")
                if classification == CLASSIFICATION_ACCEPTED:
                    accepted.append(raw)
            if attempt < args.attempts:
                time.sleep(args.interval)
    finally:
        driver.close()

    if accepted:
        latest = accepted[-1]
        fahrenheit = latest.temperature_c * 9 / 5 + 32 if latest.temperature_c is not None else None
        print(f"PASS: {len(accepted)} valid reading{'s' if len(accepted) != 1 else ''}")
        if latest.temperature_c is not None and fahrenheit is not None:
            print(f"Temperature: {latest.temperature_c:.1f} C / {fahrenheit:.1f} F")
        if latest.humidity_pct is not None:
            print(f"Humidity: {latest.humidity_pct:.1f}%")
        return 0
    print("FAIL: no valid readings")
    return 1


def _systemd_user_dir() -> Path:
    override = os.environ.get("PLANTLAB_EDGE_SYSTEMD_USER_DIR")
    if override:
        return Path(override)
    return Path.home() / ".config" / "systemd" / "user"


def cmd_sensor_mode(args: argparse.Namespace) -> int:
    mode = args.mode
    dropin_dir = _systemd_user_dir() / "plantlab-edge-agent.service.d"
    dropin_dir.mkdir(parents=True, exist_ok=True)
    managed = dropin_dir / "greenhouse-sensor-driver.conf"
    legacy_mock = dropin_dir / "greenhouse-mock.conf"
    managed.write_text(f"[Service]\nEnvironment={DRIVER_MODE_ENV}={mode}\n", encoding="utf-8")
    if legacy_mock.exists():
        legacy_mock.unlink()
    subprocess.run(["systemctl", "--user", "daemon-reload"], text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Sensor driver mode set to {mode}. Restart plantlab-edge-agent.service to apply it.")
    if legacy_mock.exists():
        print(f"Legacy mock drop-in still exists: {legacy_mock}", file=sys.stderr)
        return 1
    return 0


def _systemctl(args: list[str]) -> int:
    result = subprocess.run(["systemctl", "--user", *args], text=True)
    return result.returncode


def cmd_service_status(_args: argparse.Namespace) -> int:
    return _systemctl(["status", "plantlab-edge-agent.service", "--no-pager", "-l"])


def cmd_service_restart(_args: argparse.Namespace) -> int:
    return _systemctl(["restart", "plantlab-edge-agent.service"])


def cmd_logs(_args: argparse.Namespace) -> int:
    result = subprocess.run(["journalctl", "--user", "-u", "plantlab-edge-agent.service", "-n", "80", "--no-pager"], text=True)
    return result.returncode


def _package_content_hash() -> str:
    package_dir = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for path in sorted(package_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(package_dir).as_posix()
        if "__pycache__" in path.parts or rel.endswith(".pyc") or rel == "_install_meta.py":
            continue
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _git_commit() -> str | None:
    install_commit = getattr(_install_meta, "SOURCE_COMMIT", None) if _install_meta else None
    if install_commit:
        return str(install_commit)
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=2)
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def version_info() -> dict:
    return {
        "command": "plantlab-edge",
        "version": AGENT_VERSION,
        "runtime": AGENT_RUNTIME,
        "protocolVersion": PROTOCOL_VERSION,
        "commit": _git_commit(),
        "contentHash": _package_content_hash(),
    }


def cmd_version(args: argparse.Namespace) -> int:
    info = version_info()
    if args.json:
        print(json.dumps(info, sort_keys=True))
    else:
        commit = info["commit"] or "unknown"
        print(f"plantlab-edge {info['version']} commit {commit} hash {info['contentHash']}")
    return 0


def cmd_install_check(_args: argparse.Namespace) -> int:
    problems = []
    cfg, config_error = _load_config_safely()
    if cfg is None:
        problems.append(config_error or "edge-agent.json is missing.")
    else:
        problems.extend(config.validate_config(cfg))
    token = config.read_credential()
    if not token:
        problems.append("Credential file is missing or does not set PLANTLAB_NODE_CREDENTIAL.")
    if not camera.command_exists("ffmpeg"):
        problems.append("ffmpeg is not installed.")
    if not camera.command_exists("v4l2-ctl"):
        problems.append("v4l2-ctl is not installed (camera inventory will be limited).")
    if problems:
        for p in problems:
            print(f"PROBLEM: {p}")
        return 1
    print("OK: edge agent configuration looks complete.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="plantlab-edge")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Show local edge-agent status without secrets.").set_defaults(func=cmd_status)
    sub.add_parser("doctor", help="Run local edge-agent self-checks.").set_defaults(func=cmd_doctor)
    config_parser = sub.add_parser("config", help="Inspect local non-secret edge configuration.")
    config_sub = config_parser.add_subparsers(dest="config_command", required=True)
    config_show = config_sub.add_parser("show", help="Show resolved non-secret edge configuration.")
    config_show.add_argument("--json", action="store_true", help="Print structured JSON.")
    config_show.set_defaults(func=cmd_config_show)
    camera_parser = sub.add_parser("camera", help="Camera diagnostics.")
    camera_sub = camera_parser.add_subparsers(dest="camera_command", required=True)
    camera_list = camera_sub.add_parser("list", help="List locally discovered cameras.")
    camera_list.add_argument("--verbose", action="store_true", help="Show all advertised formats, modes, frame rates, and probe details.")
    camera_list.add_argument("--json", action="store_true", help="Print structured JSON.")
    camera_list.set_defaults(func=cmd_camera_list)
    camera_sub.add_parser("refresh", help="Run an explicit verified camera inventory refresh and post it to the coordinator.").set_defaults(func=cmd_camera_refresh)
    power_parser = sub.add_parser("power", help="Greenhouse power diagnostics and manual outlet control.")
    power_sub = power_parser.add_subparsers(dest="power_command", required=True)
    power_probe = power_sub.add_parser("probe", help="Inspect Kasa power configuration, credentials, connectivity, and outlet aliases.")
    power_probe.add_argument("--json", action="store_true", help="Print structured JSON.")
    power_probe.set_defaults(func=cmd_power_probe)
    power_sub.add_parser("status", help="Read current configured outlet states.").set_defaults(func=cmd_power_status)
    power_on = power_sub.add_parser("on", help="Turn a non-water outlet on and verify actual state.")
    power_on.add_argument("outlet_key", choices=["fans", "lights", "water"])
    power_on.set_defaults(func=cmd_power_on_off, action="on")
    power_off = power_sub.add_parser("off", help="Turn an outlet off and verify actual state.")
    power_off.add_argument("outlet_key", choices=["fans", "lights", "water"])
    power_off.set_defaults(func=cmd_power_on_off, action="off")
    power_pulse = power_sub.add_parser("pulse", help="Pulse the water outlet for a bounded duration and verify OFF.")
    power_pulse.add_argument("outlet_key", choices=["water"])
    power_pulse.add_argument("--seconds", type=int, required=True)
    power_pulse.set_defaults(func=cmd_power_pulse)
    sensor_parser = sub.add_parser("sensor", help="Environmental sensor diagnostics.")
    sensor_sub = sensor_parser.add_subparsers(dest="sensor_command", required=True)
    sensor_probe_parser = sensor_sub.add_parser("probe", help="Inspect GPIO and DHT22 backend readiness without reading a sensor.")
    sensor_probe_parser.add_argument("--json", action="store_true", help="Print structured JSON.")
    sensor_probe_parser.set_defaults(func=cmd_sensor_probe)
    sensor_test = sensor_sub.add_parser("test", help="Attempt one-shot reads from a configured DHT22 sensor.")
    sensor_test.add_argument("sensor_key", help="Configured sensor logical key.")
    sensor_test.add_argument("--attempts", type=int, default=5, help="Number of read attempts.")
    sensor_test.add_argument("--interval", type=float, default=3.0, help="Seconds to wait between attempts.")
    sensor_test.add_argument("--verbose", action="store_true", help="Show local exception class names for diagnostic failures.")
    sensor_test.set_defaults(func=cmd_sensor_test)
    sensor_mode = sensor_sub.add_parser("mode", help="Set the systemd user service sensor driver mode drop-in.")
    sensor_mode.add_argument("mode", choices=[DRIVER_MODE_MOCK, DRIVER_MODE_DHT22, DRIVER_MODE_DISABLED], help="Sensor driver mode.")
    sensor_mode.set_defaults(func=cmd_sensor_mode)
    service_parser = sub.add_parser("service", help="Manage the local edge service.")
    service_sub = service_parser.add_subparsers(dest="service_command", required=True)
    service_sub.add_parser("status", help="Show systemd user service status.").set_defaults(func=cmd_service_status)
    service_sub.add_parser("restart", help="Restart the systemd user service.").set_defaults(func=cmd_service_restart)
    sub.add_parser("logs", help="Show recent edge-agent service logs.").set_defaults(func=cmd_logs)
    version_parser = sub.add_parser("version", help="Print edge-agent version.")
    version_parser.add_argument("--json", action="store_true", help="Print structured version metadata.")
    version_parser.set_defaults(func=cmd_version)
    sub.add_parser("run", help="Run the agent loop (heartbeat, camera inventory, job polling, durable uploads).").set_defaults(func=cmd_run)
    sub.add_parser("heartbeat", help="Send one heartbeat and exit.").set_defaults(func=cmd_heartbeat)
    sub.add_parser("credential-check", help="Probe the current credential against the coordinator and exit.").set_defaults(func=cmd_credential_check)
    sub.add_parser("inventory", help="Print discovered USB/V4L2 cameras as JSON and exit.").set_defaults(func=cmd_inventory)
    sub.add_parser("install-check", help="Verify config/credential/dependencies are in place.").set_defaults(func=cmd_install_check)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
