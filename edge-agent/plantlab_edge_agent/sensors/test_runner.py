"""Shared bounded multi-attempt sensor test loop.

Extracted from the original `plantlab-edge sensor test` CLI command so the
exact same logic backs three call sites: the CLI command itself, the new
`doctor --hardware/--sensor/--all-sensors` checks, and the remote
sensor-test command executed via the coordinator protocol (see
power/runtime.py's poll_and_execute_power_command for the analogous power
pattern this mirrors). One sensor's failure never raises out of this
function - callers testing multiple sensors just call it once per sensor.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from ..config import GreenhouseSensorConfig
from .base import CLASSIFICATION_ACCEPTED, EnvironmentalSensorDriver, SensorDriverError
from .mock import DriverUnavailableError
from .validation import EnvironmentalSampleValidator

BACKEND_NAME = "pigpio"


@dataclass(frozen=True)
class SensorTestAttemptOutcome:
    attempt: int
    classification: str
    code: Optional[str]
    message: Optional[str]
    temperature_c: Optional[float]
    humidity_pct: Optional[float]


@dataclass(frozen=True)
class SensorTestResult:
    attempts: list[SensorTestAttemptOutcome] = field(default_factory=list)
    accepted_count: int = 0
    failed_count: int = 0
    final_pass: bool = False
    configured_gpio: Optional[int] = None


def run_bounded_sensor_test(
    driver: EnvironmentalSensorDriver,
    sensor: GreenhouseSensorConfig,
    attempts: int,
    interval: float,
    verbose: bool = False,
) -> SensorTestResult:
    validator = EnvironmentalSampleValidator(sensor)
    outcomes: list[SensorTestAttemptOutcome] = []
    accepted = 0
    try:
        for attempt in range(1, attempts + 1):
            try:
                raw = driver.read()
            except DriverUnavailableError as exc:
                outcomes.append(SensorTestAttemptOutcome(attempt, "driver-unavailable", getattr(exc, "code", "driver-unavailable"), str(exc), None, None))
            except SensorDriverError as exc:
                outcomes.append(SensorTestAttemptOutcome(attempt, "failed", exc.code, exc.safe_message, None, None))
            except Exception as exc:  # noqa: BLE001 - one bad attempt must not abort the whole bounded test
                message = f"{type(exc).__name__}: {exc}" if verbose else "sensor driver read failed"
                outcomes.append(SensorTestAttemptOutcome(attempt, "failed", "sensor-read-error", message, None, None))
            else:
                events = validator.evaluate(raw)
                classification = events[-1].classification if events else "unknown"
                code = events[-1].diagnostic_code if events else None
                message = events[-1].diagnostic_message if events else None
                outcomes.append(SensorTestAttemptOutcome(attempt, classification, code, message, raw.temperature_c, raw.humidity_pct))
                if classification == CLASSIFICATION_ACCEPTED:
                    accepted += 1
            if attempt < attempts:
                time.sleep(interval)
    finally:
        driver.close()

    failed = len(outcomes) - accepted
    return SensorTestResult(attempts=outcomes, accepted_count=accepted, failed_count=failed, final_pass=accepted > 0, configured_gpio=sensor.gpio)
