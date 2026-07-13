from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from ..config import EdgeAgentConfig, GreenhouseSensorConfig
from .base import (
    CLASSIFICATION_DRIVER_UNAVAILABLE,
    CLASSIFICATION_FAILED,
    EnvironmentalSensorDriver,
    SensorDriverError,
    SensorTelemetryEvent,
    utc_now,
)
from .mock import DriverUnavailableError, MockEnvironmentalSensorDriver, UnavailableEnvironmentalSensorDriver
from .validation import EnvironmentalSampleValidator, ValidationConfig

DEFAULT_SAMPLE_INTERVAL_SECONDS = 15
DEFAULT_UPLOAD_INTERVAL_SECONDS = 45
CONTINUING_DIAGNOSTIC_INTERVAL_SECONDS = 300
DRIVER_MODE_ENV = "PLANTLAB_GREENHOUSE_SENSOR_DRIVER"
DRIVER_MODE_MOCK = "mock"
DRIVER_MODE_DHT22 = "dht22"
DRIVER_MODE_DISABLED = "disabled"
DRIVER_MODE_UNAVAILABLE = "unavailable"
SUPPORTED_DRIVER_MODES = (DRIVER_MODE_MOCK, DRIVER_MODE_DHT22, DRIVER_MODE_DISABLED)


@dataclass
class RuntimeHealth:
    configured_sensor_count: int
    enabled_sensor_count: int
    accepted_sensor_count: int
    stale_sensor_count: int
    failed_sensor_count: int
    last_environment_upload_at: Optional[datetime]

    def to_heartbeat_payload(self) -> dict:
        return {
            "configuredSensorCount": self.configured_sensor_count,
            "enabledSensorCount": self.enabled_sensor_count,
            "acceptedSensorCount": self.accepted_sensor_count,
            "staleSensorCount": self.stale_sensor_count,
            "failedSensorCount": self.failed_sensor_count,
            "lastEnvironmentUploadAt": self.last_environment_upload_at.isoformat().replace("+00:00", "Z") if self.last_environment_upload_at else None,
        }


class EnvironmentalSensorRuntime:
    def __init__(
        self,
        sensor: GreenhouseSensorConfig,
        driver: EnvironmentalSensorDriver,
        validation_config: Optional[ValidationConfig] = None,
        continuing_diagnostic_interval_seconds: int = CONTINUING_DIAGNOSTIC_INTERVAL_SECONDS,
    ):
        self.sensor = sensor
        self.driver = driver
        self.validator = EnvironmentalSampleValidator(sensor, validation_config)
        self.continuing_diagnostic_interval_seconds = continuing_diagnostic_interval_seconds
        self._last_diagnostic_signature: Optional[str] = None
        self._last_diagnostic_emitted_at: Optional[datetime] = None

    def sample_once(self, now: Optional[datetime] = None) -> List[SensorTelemetryEvent]:
        now = now or utc_now()
        events: List[SensorTelemetryEvent] = []
        try:
            sample = self.driver.read()
            events.extend(self.validator.evaluate(sample))
        except DriverUnavailableError as exc:
            self.validator.mark_driver_unavailable(now)
            event = SensorTelemetryEvent.build(
                sensor=self.sensor,
                captured_at=now,
                classification=CLASSIFICATION_DRIVER_UNAVAILABLE,
                temperature_c=None,
                humidity_pct=None,
                diagnostic_code=getattr(exc, "code", "driver-unavailable"),
                diagnostic_message=str(exc),
            )
            events.append(event)
        except SensorDriverError as exc:
            self.validator.mark_driver_failure(now)
            event = SensorTelemetryEvent.build(
                sensor=self.sensor,
                captured_at=now,
                classification=CLASSIFICATION_FAILED,
                temperature_c=None,
                humidity_pct=None,
                diagnostic_code=exc.code,
                diagnostic_message=exc.safe_message,
            )
            events.append(event)
        except Exception:
            self.validator.mark_driver_failure(now)
            event = SensorTelemetryEvent.build(
                sensor=self.sensor,
                captured_at=now,
                classification=CLASSIFICATION_FAILED,
                temperature_c=None,
                humidity_pct=None,
                diagnostic_code="driver-read-failed",
                diagnostic_message="Sensor driver read failed.",
            )
            events.append(event)

        stale = self.validator.stale_event_if_due(now)
        if stale:
            events.append(stale)
        return self._dedupe_diagnostics(events, now)

    def close(self) -> None:
        try:
            self.driver.close()
        except Exception:
            pass

    def _dedupe_diagnostics(self, events: List[SensorTelemetryEvent], now: datetime) -> List[SensorTelemetryEvent]:
        emitted: List[SensorTelemetryEvent] = []
        for event in events:
            if event.classification == "accepted":
                self._last_diagnostic_signature = None
                self._last_diagnostic_emitted_at = None
                emitted.append(event)
                continue
            signature = f"{event.classification}:{event.diagnostic_code}:{event.diagnostic_message}"
            if signature != self._last_diagnostic_signature:
                self._last_diagnostic_signature = signature
                self._last_diagnostic_emitted_at = now
                emitted.append(event)
                continue
            if self._last_diagnostic_emitted_at is None or now - self._last_diagnostic_emitted_at >= timedelta(seconds=self.continuing_diagnostic_interval_seconds):
                self._last_diagnostic_emitted_at = now
                emitted.append(event)
        return emitted


class EnvironmentalSensorManager:
    def __init__(
        self,
        runtimes: List[EnvironmentalSensorRuntime],
        sample_interval_seconds: int = DEFAULT_SAMPLE_INTERVAL_SECONDS,
        upload_interval_seconds: int = DEFAULT_UPLOAD_INTERVAL_SECONDS,
    ):
        self.runtimes = runtimes
        self.sample_interval_seconds = sample_interval_seconds
        self.upload_interval_seconds = upload_interval_seconds
        self.next_sample_at: Optional[datetime] = None
        self.next_upload_at: Optional[datetime] = None
        self.last_environment_upload_at: Optional[datetime] = None

    @classmethod
    def from_config(cls, cfg: EdgeAgentConfig) -> "EnvironmentalSensorManager":
        sample_interval = getattr(cfg, "sensor_sample_interval_seconds", DEFAULT_SAMPLE_INTERVAL_SECONDS)
        upload_interval = getattr(cfg, "environment_upload_interval_seconds", DEFAULT_UPLOAD_INTERVAL_SECONDS)
        validation_config = ValidationConfig(stale_timeout_seconds=max(sample_interval * 3, 30))
        driver_mode = selected_driver_mode()
        if driver_mode not in (DRIVER_MODE_MOCK, DRIVER_MODE_DHT22, DRIVER_MODE_DISABLED, DRIVER_MODE_UNAVAILABLE):
            raise ValueError(f'Unsupported greenhouse sensor driver mode "{driver_mode}". Supported values: mock, dht22, disabled.')
        if driver_mode == DRIVER_MODE_DISABLED:
            return cls([], sample_interval, upload_interval)
        runtimes: List[EnvironmentalSensorRuntime] = []
        for sensor in cfg.sensors:
            if not sensor.enabled:
                continue
            driver: EnvironmentalSensorDriver
            if driver_mode == "mock":
                driver = MockEnvironmentalSensorDriver(sensor.key)
            elif driver_mode == "dht22":
                if sensor.type != "dht22":
                    driver = UnavailableEnvironmentalSensorDriver(f'No real driver is available for sensor type "{sensor.type}".')
                else:
                    from .dht22 import DHT22PigpioDriver

                    driver = DHT22PigpioDriver(sensor)
            else:
                driver = UnavailableEnvironmentalSensorDriver("No greenhouse sensor driver mode is selected. Set PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22 for real hardware, mock for development, or disabled.")
            runtimes.append(EnvironmentalSensorRuntime(sensor, driver, validation_config))
        return cls(runtimes, sample_interval, upload_interval)

    def sample_due(self, now: Optional[datetime] = None) -> List[SensorTelemetryEvent]:
        now = now or utc_now()
        if self.next_sample_at is not None and now < self.next_sample_at:
            return []
        self.next_sample_at = now + timedelta(seconds=self.sample_interval_seconds)
        events: List[SensorTelemetryEvent] = []
        for runtime in self.runtimes:
            events.extend(runtime.sample_once(now))
        return events

    def upload_due(self, now: Optional[datetime] = None) -> bool:
        now = now or utc_now()
        if self.next_upload_at is not None and now < self.next_upload_at:
            return False
        self.next_upload_at = now + timedelta(seconds=self.upload_interval_seconds)
        return True

    def mark_uploaded(self, when: Optional[datetime] = None) -> None:
        self.last_environment_upload_at = when or utc_now()

    def health(self, cfg: EdgeAgentConfig) -> RuntimeHealth:
        accepted = 0
        stale = 0
        failed = 0
        for runtime in self.runtimes:
            classification = runtime.validator.state.latest_classification
            if classification == "accepted":
                accepted += 1
            elif classification == "stale":
                stale += 1
            elif classification in ("failed", "driver-unavailable"):
                failed += 1
        return RuntimeHealth(
            configured_sensor_count=len(cfg.sensors),
            enabled_sensor_count=len([sensor for sensor in cfg.sensors if sensor.enabled]),
            accepted_sensor_count=accepted,
            stale_sensor_count=stale,
            failed_sensor_count=failed,
            last_environment_upload_at=self.last_environment_upload_at,
        )

    def close(self) -> None:
        for runtime in self.runtimes:
            runtime.close()


def selected_driver_mode(env: Optional[dict[str, str]] = None) -> str:
    source = os.environ if env is None else env
    raw = source.get(DRIVER_MODE_ENV, "").strip().lower()
    if not raw:
        return DRIVER_MODE_UNAVAILABLE
    return raw
