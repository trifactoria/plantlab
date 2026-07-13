from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Protocol

from ..config import GreenhouseSensorConfig

CLASSIFICATION_ACCEPTED = "accepted"
CLASSIFICATION_SUSPECT = "suspect"
CLASSIFICATION_REJECTED = "rejected"
CLASSIFICATION_FAILED = "failed"
CLASSIFICATION_STALE = "stale"
CLASSIFICATION_DRIVER_UNAVAILABLE = "driver-unavailable"

CLASSIFICATIONS = (
    CLASSIFICATION_ACCEPTED,
    CLASSIFICATION_SUSPECT,
    CLASSIFICATION_REJECTED,
    CLASSIFICATION_FAILED,
    CLASSIFICATION_STALE,
    CLASSIFICATION_DRIVER_UNAVAILABLE,
)


@dataclass(frozen=True)
class RawEnvironmentalSample:
    temperature_c: Optional[float]
    humidity_pct: Optional[float]
    captured_at: datetime


class EnvironmentalSensorDriver(Protocol):
    def read(self) -> RawEnvironmentalSample:
        ...


@dataclass(frozen=True)
class SensorTelemetryEvent:
    event_id: str
    sensor: GreenhouseSensorConfig
    captured_at: datetime
    classification: str
    temperature_c: Optional[float]
    humidity_pct: Optional[float]
    diagnostic_code: Optional[str] = None
    diagnostic_message: Optional[str] = None

    @staticmethod
    def build(
        *,
        sensor: GreenhouseSensorConfig,
        captured_at: datetime,
        classification: str,
        temperature_c: Optional[float],
        humidity_pct: Optional[float],
        diagnostic_code: Optional[str] = None,
        diagnostic_message: Optional[str] = None,
        seed: str = "",
    ) -> "SensorTelemetryEvent":
        event_id = stable_event_id(sensor.key, captured_at, classification, temperature_c, humidity_pct, diagnostic_code, seed)
        return SensorTelemetryEvent(
            event_id=event_id,
            sensor=sensor,
            captured_at=captured_at,
            classification=classification,
            temperature_c=temperature_c,
            humidity_pct=humidity_pct,
            diagnostic_code=diagnostic_code,
            diagnostic_message=safe_message(diagnostic_message),
        )

    def to_wire(self) -> dict:
        return {
            "eventId": self.event_id,
            "sensor": {
                "key": self.sensor.key,
                "name": self.sensor.name,
                "type": self.sensor.type,
                "gpio": self.sensor.gpio,
                "placement": self.sensor.placement,
                "enabled": self.sensor.enabled,
            },
            "capturedAt": isoformat_utc(self.captured_at),
            "classification": self.classification,
            "temperatureC": self.temperature_c,
            "humidityPct": self.humidity_pct,
            "diagnosticCode": self.diagnostic_code,
            "diagnosticMessage": self.diagnostic_message,
        }


def stable_event_id(
    sensor_key: str,
    captured_at: datetime,
    classification: str,
    temperature_c: Optional[float],
    humidity_pct: Optional[float],
    diagnostic_code: Optional[str],
    seed: str = "",
) -> str:
    source = "|".join(
        [
            sensor_key,
            isoformat_utc(captured_at),
            classification,
            "" if temperature_c is None else f"{temperature_c:.4f}",
            "" if humidity_pct is None else f"{humidity_pct:.4f}",
            diagnostic_code or "",
            seed,
        ]
    )
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def isoformat_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def safe_message(message: Optional[str]) -> Optional[str]:
    if not message:
        return None
    cleaned = " ".join(str(message).split())
    return cleaned[:500]
