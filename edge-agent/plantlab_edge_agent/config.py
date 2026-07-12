"""Config and credential loading for the PlantLab edge agent.

Deliberately independent of the full TypeScript agent's
`plantlab.config.json` (repo-root-relative, format-versioned - see
src/lib/operations/config.ts). The edge agent has no repo root by design
(Part 12: a small deployment directory, not a full clone), so it keeps its
own small config file at ``~/.config/plantlab/edge-agent.json``. It reads
the credential from the *same* path/format the full agent uses
(``~/.config/plantlab/agent.env``, ``PLANTLAB_NODE_CREDENTIAL=...``) so
probeRemoteCredential() and the credential-repair flow work identically for
either runtime - see docs/AGENT_PROTOCOL.md.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

CONFIG_DIR = Path(os.environ.get("PLANTLAB_EDGE_CONFIG_DIR", str(Path.home() / ".config" / "plantlab")))
CONFIG_PATH = CONFIG_DIR / "edge-agent.json"
CREDENTIAL_PATH = CONFIG_DIR / "agent.env"
DEFAULT_SPOOL_ROOT = Path.home() / ".local" / "state" / "plantlab-edge-agent"


class ConfigError(Exception):
    pass


@dataclass
class EdgeAgentConfig:
    role: str
    node_name: str
    coordinator_url: str
    spool_root: str
    capabilities: List[str]
    heartbeat_interval_seconds: int = 30
    poll_interval_seconds: int = 5
    max_spool_bytes: int = 512 * 1024 * 1024  # 512MB - a Pi Zero's whole SD card is usually 8-32GB, but this stays conservative.
    max_upload_bytes: int = 8 * 1024 * 1024  # A single frame should be a few hundred KB at 720p JPEG; 8MB is a generous cap, not a target.


def read_config() -> Optional[EdgeAgentConfig]:
    """Returns None if not configured yet - never raises for a missing file, matching config.ts's readNodeConfig()."""
    if not CONFIG_PATH.exists():
        return None
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    return EdgeAgentConfig(
        role=raw.get("role", "greenhouse-node"),
        node_name=raw.get("nodeName") or raw.get("node_name") or "",
        coordinator_url=raw.get("coordinatorUrl") or raw.get("coordinator_url") or "",
        spool_root=raw.get("spoolRoot") or raw.get("spool_root") or str(DEFAULT_SPOOL_ROOT),
        capabilities=raw.get("capabilities", ["camera"]),
        heartbeat_interval_seconds=int(raw.get("heartbeatIntervalSeconds", 30)),
        poll_interval_seconds=int(raw.get("pollIntervalSeconds", 5)),
        max_spool_bytes=int(raw.get("maxSpoolBytes", 512 * 1024 * 1024)),
        max_upload_bytes=int(raw.get("maxUploadBytes", 8 * 1024 * 1024)),
    )


def write_config(config: EdgeAgentConfig) -> None:
    """Atomic write (temp file + rename), same pattern as writeNodeConfigRaw() in config.ts."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "role": config.role,
        "nodeName": config.node_name,
        "coordinatorUrl": config.coordinator_url,
        "spoolRoot": config.spool_root,
        "capabilities": config.capabilities,
        "heartbeatIntervalSeconds": config.heartbeat_interval_seconds,
        "pollIntervalSeconds": config.poll_interval_seconds,
        "maxSpoolBytes": config.max_spool_bytes,
        "maxUploadBytes": config.max_upload_bytes,
    }
    tmp_path = CONFIG_PATH.with_name(f".{CONFIG_PATH.name}.tmp-{os.getpid()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp_path, CONFIG_PATH)


def read_credential() -> Optional[str]:
    """Returns None (never raises) if the file is missing/empty/malformed - the agent's own startup check turns that into a clear fatal error, matching agent-service.ts's behavior."""
    if not CREDENTIAL_PATH.exists():
        return None
    try:
        content = CREDENTIAL_PATH.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in content.splitlines():
        if line.startswith("PLANTLAB_NODE_CREDENTIAL="):
            value = line[len("PLANTLAB_NODE_CREDENTIAL="):].strip()
            return value or None
    return None


def write_credential(token: str) -> None:
    """Atomic write (mktemp-equivalent + rename) with 0600/0700 permissions - mirrors the mktemp+mv pattern in systemdUnits.ts's buildUnitConvergenceScript, which never writes through a stale mask symlink via plain redirection."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)
    tmp_path = CREDENTIAL_PATH.with_name(f".{CREDENTIAL_PATH.name}.tmp-{os.getpid()}")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"PLANTLAB_NODE_CREDENTIAL={token}\n")
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    os.replace(tmp_path, CREDENTIAL_PATH)
    os.chmod(CREDENTIAL_PATH, 0o600)
