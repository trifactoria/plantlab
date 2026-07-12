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
import json
import sys

from . import agent, camera, config
from .protocol import ProtocolError, platform_info


def cmd_run(_args: argparse.Namespace) -> int:
    try:
        agent.run_loop()
    except agent.FatalAgentError as exc:
        print(f"Fatal PlantLab edge agent error: {exc}", file=sys.stderr)
        return 1
    return 0


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
    print(json.dumps([{"device": c.device, "name": c.name, "stableId": c.stable_id} for c in cameras], indent=2))
    return 0


def cmd_install_check(_args: argparse.Namespace) -> int:
    problems = []
    cfg = config.read_config()
    if cfg is None:
        problems.append("edge-agent.json is missing.")
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
    parser = argparse.ArgumentParser(prog="plantlab_edge_agent")
    sub = parser.add_subparsers(dest="command", required=True)
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
