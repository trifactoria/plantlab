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
import subprocess
import sys
from pathlib import Path

from . import agent, camera, config
from .protocol import AGENT_RUNTIME, AGENT_VERSION, PROTOCOL_VERSION, AgentProtocolClient, ProtocolError, platform_info, request_json

try:
    from . import _install_meta
except Exception:  # pragma: no cover - absent in source checkouts before install.sh writes it
    _install_meta = None


def _load_config_safely():
    try:
        return config.read_config(), None
    except Exception as exc:
        return None, str(exc)


def _config_summary(cfg: config.EdgeAgentConfig | None) -> dict:
    token = config.read_credential()
    greenhouse_secret_path = config.CONFIG_DIR / "greenhouse.env"
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
        "maxSpoolBytes": cfg.max_spool_bytes if cfg else None,
        "maxUploadBytes": cfg.max_upload_bytes if cfg else None,
        "credentialPresent": bool(token),
        "credentialLength": len(token) if token else 0,
        "greenhouseSecretPath": str(greenhouse_secret_path),
        "greenhouseSecretPresent": greenhouse_secret_path.exists(),
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
    print(f"Greenhouse secret file: {'present' if summary['greenhouseSecretPresent'] else 'missing'} ({summary['greenhouseSecretPath']})")
    print(f"Heartbeat interval: {summary['heartbeatIntervalSeconds'] or '(missing)'}")
    print(f"Poll interval: {summary['pollIntervalSeconds'] or '(missing)'}")
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
