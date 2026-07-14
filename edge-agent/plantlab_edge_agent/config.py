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
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

CONFIG_DIR = Path(os.environ.get("PLANTLAB_EDGE_CONFIG_DIR", str(Path.home() / ".config" / "plantlab")))
CONFIG_PATH = CONFIG_DIR / "edge-agent.json"
CREDENTIAL_PATH = CONFIG_DIR / "agent.env"
GREENHOUSE_SECRET_PATH = CONFIG_DIR / "greenhouse.env"
DEFAULT_SPOOL_ROOT = Path.home() / ".local" / "state" / "plantlab-edge-agent"


class ConfigError(Exception):
    pass


@dataclass
class GreenhouseSensorConfig:
    key: str
    name: str
    type: str
    gpio: int
    placement: Optional[str] = None
    enabled: bool = True


@dataclass
class GreenhousePowerConfig:
    provider: str
    host: str
    outlets: Dict[str, str] = field(default_factory=dict)


@dataclass
class EdgeAgentConfig:
    role: str
    node_name: str
    coordinator_url: str
    spool_root: str
    capabilities: List[str]
    sensors: List[GreenhouseSensorConfig] = field(default_factory=list)
    power: Optional[GreenhousePowerConfig] = None
    heartbeat_interval_seconds: int = 30
    poll_interval_seconds: int = 5
    camera_refresh_poll_interval_seconds: int = 60
    power_command_poll_interval_seconds: int = 5
    power_state_refresh_interval_seconds: int = 60
    sensor_test_poll_interval_seconds: int = 10
    spool_cleanup_interval_seconds: int = 600
    sensor_sample_interval_seconds: int = 15
    environment_upload_interval_seconds: int = 45
    max_spool_bytes: int = 512 * 1024 * 1024  # 512MB - a Pi Zero's whole SD card is usually 8-32GB, but this stays conservative.
    max_upload_bytes: int = 8 * 1024 * 1024  # A single frame should be a few hundred KB at 720p JPEG; 8MB is a generous cap, not a target.


def read_config() -> Optional[EdgeAgentConfig]:
    """Returns None if not configured yet - never raises for a missing file, matching config.ts's readNodeConfig()."""
    if not CONFIG_PATH.exists():
        return None
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ConfigError("edge-agent.json must contain a JSON object.")
    sensors = parse_sensors(raw.get("sensors"))
    power = parse_power(raw.get("power"))
    raw_capabilities = raw.get("capabilities", ["camera"])
    if not isinstance(raw_capabilities, list):
        raw_capabilities = []
    role = raw.get("role", "greenhouse-node")
    capabilities = derive_capabilities(
        role=role,
        current=[item for item in raw_capabilities if isinstance(item, str)],
        sensors=sensors,
        power=power,
    )
    return EdgeAgentConfig(
        role=role,
        node_name=raw.get("nodeName") or raw.get("node_name") or "",
        coordinator_url=raw.get("coordinatorUrl") or raw.get("coordinator_url") or "",
        spool_root=raw.get("spoolRoot") or raw.get("spool_root") or str(DEFAULT_SPOOL_ROOT),
        capabilities=capabilities,
        sensors=sensors,
        power=power,
        heartbeat_interval_seconds=int(raw.get("heartbeatIntervalSeconds", 30)),
        poll_interval_seconds=int(raw.get("pollIntervalSeconds", 5)),
        camera_refresh_poll_interval_seconds=int(raw.get("cameraRefreshPollIntervalSeconds", 60)),
        power_command_poll_interval_seconds=int(raw.get("powerCommandPollIntervalSeconds", 5)),
        power_state_refresh_interval_seconds=int(raw.get("powerStateRefreshIntervalSeconds", 60)),
        sensor_test_poll_interval_seconds=int(raw.get("sensorTestPollIntervalSeconds", 10)),
        spool_cleanup_interval_seconds=int(raw.get("spoolCleanupIntervalSeconds", 600)),
        sensor_sample_interval_seconds=int(raw.get("sensorSampleIntervalSeconds", 15)),
        environment_upload_interval_seconds=int(raw.get("environmentUploadIntervalSeconds", 45)),
        max_spool_bytes=int(raw.get("maxSpoolBytes", 512 * 1024 * 1024)),
        max_upload_bytes=int(raw.get("maxUploadBytes", 8 * 1024 * 1024)),
    )


def config_to_payload(config: EdgeAgentConfig) -> dict:
    payload = {
        "role": config.role,
        "nodeName": config.node_name,
        "coordinatorUrl": config.coordinator_url,
        "spoolRoot": config.spool_root,
        "capabilities": config.capabilities,
        "heartbeatIntervalSeconds": config.heartbeat_interval_seconds,
        "pollIntervalSeconds": config.poll_interval_seconds,
        "cameraRefreshPollIntervalSeconds": config.camera_refresh_poll_interval_seconds,
        "powerCommandPollIntervalSeconds": config.power_command_poll_interval_seconds,
        "powerStateRefreshIntervalSeconds": config.power_state_refresh_interval_seconds,
        "sensorTestPollIntervalSeconds": config.sensor_test_poll_interval_seconds,
        "spoolCleanupIntervalSeconds": config.spool_cleanup_interval_seconds,
        "sensorSampleIntervalSeconds": config.sensor_sample_interval_seconds,
        "environmentUploadIntervalSeconds": config.environment_upload_interval_seconds,
        "maxSpoolBytes": config.max_spool_bytes,
        "maxUploadBytes": config.max_upload_bytes,
    }
    if config.sensors:
        payload["sensors"] = [
            {
                "key": sensor.key,
                "name": sensor.name,
                "type": sensor.type,
                "gpio": sensor.gpio,
                "placement": sensor.placement,
                "enabled": sensor.enabled,
            }
            for sensor in config.sensors
        ]
    if config.power:
        payload["power"] = {"provider": config.power.provider, "host": config.power.host, "outlets": dict(config.power.outlets)}
    return payload


def write_config(config: EdgeAgentConfig) -> None:
    """Atomic write (temp file + rename), same pattern as writeNodeConfigRaw() in config.ts."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = config_to_payload(config)
    tmp_path = CONFIG_PATH.with_name(f".{CONFIG_PATH.name}.tmp-{os.getpid()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, CONFIG_PATH)


def parse_sensors(raw) -> List[GreenhouseSensorConfig]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ConfigError("sensors must be an array.")
    sensors: List[GreenhouseSensorConfig] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ConfigError(f"sensors[{index}] must be an object.")
        key = _required_string(item.get("key"), f"sensors[{index}].key")
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", key):
            raise ConfigError(f"sensors[{index}].key must contain only letters, numbers, underscores, and hyphens.")
        name = _required_string(item.get("name"), f"sensors[{index}].name")
        sensor_type = _required_string(item.get("type"), f"sensors[{index}].type")
        if sensor_type != "dht22":
            raise ConfigError(f'Unsupported sensor type "{sensor_type}". Supported sensor types: dht22.')
        gpio = item.get("gpio")
        if not isinstance(gpio, int) or isinstance(gpio, bool) or gpio < 0 or gpio > 27:
            raise ConfigError(f"sensors[{index}].gpio must be a BCM GPIO number from 0 to 27.")
        if "enabled" in item and not isinstance(item.get("enabled"), bool):
            raise ConfigError(f"sensors[{index}].enabled must be a boolean when present.")
        placement_raw = item.get("placement")
        placement = str(placement_raw).strip() if placement_raw is not None else None
        sensors.append(
            GreenhouseSensorConfig(
                key=key,
                name=name,
                type=sensor_type,
                gpio=gpio,
                placement=placement or None,
                enabled=item.get("enabled", True),
            )
        )
    _validate_sensor_set(sensors)
    return sensors


def parse_power(raw) -> Optional[GreenhousePowerConfig]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ConfigError("power must be an object.")
    if raw.get("enabled") is False:
        return None
    provider = _required_string(raw.get("provider"), "power.provider")
    if provider != "kasa":
        raise ConfigError(f'Unsupported power provider "{provider}". Supported providers: kasa.')
    host = _required_string(raw.get("host"), "power.host")
    outlets_raw = raw.get("outlets", {})
    if not isinstance(outlets_raw, dict):
        raise ConfigError("power.outlets must be an object.")
    outlets: Dict[str, str] = {}
    for key, value in outlets_raw.items():
        if key not in ("fans", "water", "lights"):
            raise ConfigError(f'Unsupported power outlet key "{key}". Supported keys: fans, water, lights.')
        if not isinstance(value, str) or not value.strip():
            raise ConfigError(f"power.outlets.{key} must be a non-empty string when present.")
        outlets[key] = value.strip()
    return GreenhousePowerConfig(provider=provider, host=host, outlets=outlets)


def derive_capabilities(
    *,
    role: str,
    current: List[str],
    sensors: List[GreenhouseSensorConfig],
    power: Optional[GreenhousePowerConfig],
) -> List[str]:
    capabilities: List[str] = []
    if "camera" in current:
        capabilities.append("camera")
    if role != "greenhouse-node":
        return _unique_capabilities(capabilities)
    if any(sensor.enabled and sensor.type == "dht22" for sensor in sensors):
        capabilities.extend(["temperature", "humidity"])
    if power:
        capabilities.append("relay")
        if power.outlets.get("fans"):
            capabilities.append("fan")
        if power.outlets.get("lights"):
            capabilities.append("light")
        if power.outlets.get("water"):
            capabilities.append("pump")
    return _unique_capabilities(capabilities)


def _required_string(value, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{label} is required.")
    return value.strip()


def _validate_sensor_set(sensors: List[GreenhouseSensorConfig]) -> None:
    keys = set()
    gpios = set()
    for sensor in sensors:
        if sensor.key in keys:
            raise ConfigError(f'Duplicate sensor key "{sensor.key}".')
        keys.add(sensor.key)
        if sensor.gpio in gpios:
            raise ConfigError(f"Duplicate BCM GPIO assignment {sensor.gpio}.")
        gpios.add(sensor.gpio)


def _unique_capabilities(values: List[str]) -> List[str]:
    valid = {"camera", "temperature", "humidity", "soil-moisture", "relay", "fan", "light", "pump", "microscope"}
    result: List[str] = []
    for value in values:
        if value in valid and value not in result:
            result.append(value)
    return result


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


def read_greenhouse_secrets() -> Dict[str, str]:
    if not GREENHOUSE_SECRET_PATH.exists():
        return {}
    secrets: Dict[str, str] = {}
    for raw_line in GREENHOUSE_SECRET_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        secrets[key] = value
    return secrets


def validate_config(config: EdgeAgentConfig) -> List[str]:
    problems: List[str] = []
    if not config.node_name:
        problems.append("nodeName is missing.")
    if not config.role:
        problems.append("role is missing.")
    parsed = urlparse(config.coordinator_url)
    if not config.coordinator_url:
        problems.append("coordinatorUrl is missing.")
    elif parsed.scheme not in ("http", "https") or not parsed.netloc:
        problems.append("coordinatorUrl must be an http(s) URL.")
    if not config.spool_root:
        problems.append("spoolRoot is missing.")
    if not config.capabilities:
        problems.append("capabilities is empty.")
    if config.sensor_sample_interval_seconds < 1:
        problems.append("sensorSampleIntervalSeconds must be positive.")
    if config.environment_upload_interval_seconds < 1:
        problems.append("environmentUploadIntervalSeconds must be positive.")
    try:
        _validate_sensor_set(config.sensors)
    except ConfigError as exc:
        problems.append(str(exc))
    for index, sensor in enumerate(config.sensors):
        if sensor.type != "dht22":
            problems.append(f'Unsupported sensor type "{sensor.type}". Supported sensor types: dht22.')
        if not isinstance(sensor.gpio, int) or isinstance(sensor.gpio, bool) or sensor.gpio < 0 or sensor.gpio > 27:
            problems.append(f"sensors[{index}].gpio must be a BCM GPIO number from 0 to 27.")
    if config.power:
        if config.power.provider != "kasa":
            problems.append(f'Unsupported power provider "{config.power.provider}". Supported providers: kasa.')
        if not config.power.host:
            problems.append("power.host is required.")
    return problems


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
