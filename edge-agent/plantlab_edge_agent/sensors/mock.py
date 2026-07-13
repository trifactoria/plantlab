from __future__ import annotations

import math
from datetime import datetime
from typing import List, Optional, Tuple

from .base import RawEnvironmentalSample, utc_now


class MockEnvironmentalSensorDriver:
    """Deterministic, hardware-free DHT22-compatible mock driver.

    Tests can inject explicit samples/failures. Without injections it
    produces stable realistic greenhouse values with gradual variation.
    """

    def __init__(self, sensor_key: str, base_temperature_c: float = 24.0, base_humidity_pct: float = 65.0):
        self.sensor_key = sensor_key
        self.base_temperature_c = base_temperature_c
        self.base_humidity_pct = base_humidity_pct
        self._index = 0
        self._injected: List[RawEnvironmentalSample | Exception] = []

    def inject_sample(self, temperature_c: Optional[float], humidity_pct: Optional[float], captured_at: Optional[datetime] = None) -> None:
        self._injected.append(RawEnvironmentalSample(temperature_c=temperature_c, humidity_pct=humidity_pct, captured_at=captured_at or utc_now()))

    def inject_failure(self, message: str = "mock read failure") -> None:
        self._injected.append(RuntimeError(message))

    def inject_impossible_value(self) -> None:
        self.inject_sample(1000.0, -10.0)

    def inject_spike(self) -> None:
        self.inject_sample(self.base_temperature_c + 14.0, self.base_humidity_pct + 35.0)

    def read(self) -> RawEnvironmentalSample:
        if self._injected:
            next_item = self._injected.pop(0)
            if isinstance(next_item, Exception):
                raise next_item
            return next_item
        self._index += 1
        return RawEnvironmentalSample(
            temperature_c=round(self.base_temperature_c + math.sin(self._index / 8.0) * 0.6, 2),
            humidity_pct=round(self.base_humidity_pct + math.cos(self._index / 10.0) * 1.5, 2),
            captured_at=utc_now(),
        )

    def close(self) -> None:
        return None


class UnavailableEnvironmentalSensorDriver:
    def __init__(self, reason: str):
        self.reason = reason

    def read(self) -> RawEnvironmentalSample:
        raise DriverUnavailableError(self.reason)

    def close(self) -> None:
        return None


class DriverUnavailableError(Exception):
    def __init__(self, reason: str, code: str = "driver-unavailable"):
        super().__init__(reason)
        self.code = code
