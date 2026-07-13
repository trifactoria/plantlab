from __future__ import annotations

import getpass
import grp
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .. import config
from . import dht22
from .runtime import selected_driver_mode


def collect_probe(cfg: config.EdgeAgentConfig | None = None) -> dict[str, Any]:
    sensors = cfg.sensors if cfg else []
    gpiochips = sorted(path.name for path in Path("/dev").glob("gpiochip*"))
    gpiomem = Path("/dev/gpiomem")
    dependency_available, dependency_detail = dht22.backend_available()
    backend_ready, backend_detail = dht22.backend_ready() if dependency_available else (False, dependency_detail)
    spi = _detect_spi()
    warnings = _warnings(sensors, spi, gpiomem)
    return {
        "platformModel": _platform_model(),
        "architecture": platform.machine(),
        "pythonVersion": platform.python_version(),
        "gpioDevices": gpiochips,
        "gpioDeviceAvailable": bool(gpiochips),
        "gpiomemExists": gpiomem.exists(),
        "gpiomemReadableWritable": os.access(gpiomem, os.R_OK | os.W_OK) if gpiomem.exists() else False,
        "gpioGroupMember": _gpio_group_member(),
        "user": getpass.getuser(),
        "configuredSensors": [
            {
                "key": sensor.key,
                "name": sensor.name,
                "type": sensor.type,
                "gpio": sensor.gpio,
                "placement": sensor.placement,
                "enabled": sensor.enabled,
            }
            for sensor in sensors
        ],
        "configuredBcmPins": [sensor.gpio for sensor in sensors if sensor.enabled],
        "spi": spi,
        "selectedDriverMode": selected_driver_mode(),
        "dht22Backend": "pigpio",
        "backendDependencyAvailable": dependency_available,
        "backendDependencyDetail": dependency_detail,
        "backendReady": backend_ready,
        "backendReadinessDetail": backend_detail,
        "pigpiodCommandAvailable": shutil.which("pigpiod") is not None,
        "gpioinfoCommandAvailable": shutil.which("gpioinfo") is not None,
        "warnings": warnings,
    }


def print_probe(probe: dict[str, Any]) -> None:
    print(f"Platform model: {probe['platformModel'] or '(unknown)'}")
    print(f"Architecture: {probe['architecture']}")
    print(f"Python version: {probe['pythonVersion']}")
    print(f"GPIO character devices: {', '.join(probe['gpioDevices']) if probe['gpioDevices'] else '(none)'}")
    print(f"/dev/gpiomem: {'available' if probe['gpiomemExists'] else 'missing'}")
    print(f"GPIO group membership: {'yes' if probe['gpioGroupMember'] else 'no'}")
    print(f"Selected sensor driver mode: {probe['selectedDriverMode']}")
    print(f"DHT22 backend: {'ready' if probe['backendReady'] else 'unavailable'}")
    print(f"Backend: {probe['dht22Backend']}")
    print(f"Backend dependency: {'available' if probe['backendDependencyAvailable'] else 'missing'} ({probe['backendDependencyDetail']})")
    print(f"Backend readiness: {probe['backendReadinessDetail']}")
    print(f"pigpiod command: {'available' if probe['pigpiodCommandAvailable'] else 'missing'}")
    print(f"SPI status: {'enabled or present' if probe['spi']['possiblyEnabled'] else 'not detected'}")
    if probe["configuredSensors"]:
        for sensor in probe["configuredSensors"]:
            print(f"Configured sensor: {sensor['key']}")
            print(f"  Type: {sensor['type']}")
            print(f"  BCM GPIO: {sensor['gpio']}")
            print(f"  Placement: {sensor['placement'] or '(none)'}")
            print(f"  Enabled: {'yes' if sensor['enabled'] else 'no'}")
    else:
        print("Configured sensors: none")
    if probe["warnings"]:
        print("Warnings:")
        for warning in probe["warnings"]:
            print(f"  - {warning}")
    else:
        print("Warnings: none")


def _platform_model() -> str | None:
    for candidate in (Path("/proc/device-tree/model"), Path("/sys/firmware/devicetree/base/model")):
        try:
            text = candidate.read_text(encoding="utf-8", errors="ignore").replace("\x00", "").strip()
            if text:
                return text
        except OSError:
            pass
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    match = re.search(r"^Model\s*:\s*(.+)$", cpuinfo, re.MULTILINE)
    return match.group(1).strip() if match else None


def _gpio_group_member() -> bool:
    try:
        gpio_gid = grp.getgrnam("gpio").gr_gid
    except KeyError:
        return False
    return gpio_gid in os.getgroups()


def _detect_spi() -> dict[str, Any]:
    config_hits: list[str] = []
    for path in (Path("/boot/firmware/config.txt"), Path("/boot/config.txt")):
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                cleaned = line.strip()
                if cleaned and not cleaned.startswith("#") and "dtparam=spi=on" in cleaned:
                    config_hits.append(f"{path}:{cleaned}")
        except OSError:
            pass
    spidev = sorted(path.name for path in Path("/dev").glob("spidev*"))
    module_loaded = False
    try:
        modules = Path("/proc/modules").read_text(encoding="utf-8", errors="ignore")
        module_loaded = "spi_bcm" in modules or "spidev" in modules
    except OSError:
        pass
    return {
        "configHits": config_hits,
        "spidevDevices": spidev,
        "moduleLoaded": module_loaded,
        "possiblyEnabled": bool(config_hits or spidev or module_loaded),
    }


def _warnings(sensors: list[config.GreenhouseSensorConfig], spi: dict[str, Any], gpiomem: Path) -> list[str]:
    warnings: list[str] = []
    enabled_pins = [sensor.gpio for sensor in sensors if sensor.enabled]
    if not gpiomem.exists() and not list(Path("/dev").glob("gpiochip*")):
        warnings.append("No GPIO device was found; real DHT22 reads will fail until GPIO access is available.")
    if not _gpio_group_member():
        warnings.append("Current user is not in the gpio group; GPIO permissions may fail in a user service.")
    for pin in enabled_pins:
        if pin in (2, 3):
            warnings.append(f"BCM GPIO {pin} is commonly reserved for I2C; verify this is intentional.")
        if pin in (7, 8, 9, 10, 11) and spi.get("possiblyEnabled"):
            warnings.append(f"BCM GPIO {pin} overlaps SPI pins; SPI appears enabled or present. Do not disable SPI automatically.")
        if pin > 27:
            warnings.append(f"BCM GPIO {pin} is outside the Raspberry Pi 40-pin header GPIO range.")
        if pin in (24, 26):
            warnings.append(f"BCM GPIO {pin} is sometimes confused with physical header pin numbering; confirm BCM numbering.")
    return warnings


def run_command(args: list[str], timeout: int = 5) -> tuple[int, str]:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return result.returncode, (result.stdout + result.stderr).strip()
    except Exception as exc:
        return 255, str(exc)
