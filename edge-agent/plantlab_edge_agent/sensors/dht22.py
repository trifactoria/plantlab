from __future__ import annotations

import importlib
import time
from typing import Any, Callable, Optional

from ..config import GreenhouseSensorConfig
from .base import RawEnvironmentalSample, SensorDriverError, utc_now
from .mock import DriverUnavailableError

BACKEND_NAME = "pigpio"
DHT22_MIN_INTERVAL_SECONDS = 2.0


class DHT22PigpioDriver:
    """DHT22 reader backed by the pigpio daemon.

    pigpiod owns GPIO timing; this class only toggles the data line and
    decodes the resulting edge timings. That keeps the main PlantLab loop out
    of tight GPIO polling and makes failures ordinary driver diagnostics.
    """

    def __init__(
        self,
        sensor: GreenhouseSensorConfig,
        *,
        pigpio_module: Any | None = None,
        pi_factory: Optional[Callable[[], Any]] = None,
        read_timeout_seconds: float = 2.0,
        settle_seconds: float = DHT22_MIN_INTERVAL_SECONDS,
    ):
        self.sensor = sensor
        self.gpio = sensor.gpio
        self._pigpio = pigpio_module
        self._pi_factory = pi_factory
        self._pi = None
        self._read_timeout_seconds = read_timeout_seconds
        self._settle_seconds = settle_seconds
        self._last_read_at = 0.0

    def read(self) -> RawEnvironmentalSample:
        now = time.monotonic()
        elapsed = now - self._last_read_at
        if self._last_read_at and elapsed < self._settle_seconds:
            time.sleep(self._settle_seconds - elapsed)
        self._last_read_at = time.monotonic()

        pi = self._connect()
        bits: list[int] = []
        high_pulses: list[int] = []
        last_tick: Optional[int] = None
        last_level: Optional[int] = None

        def callback(_gpio: int, level: int, tick: int) -> None:
            nonlocal last_tick, last_level
            if last_tick is not None and last_level == 1 and level == 0:
                high_pulses.append(int(self._pigpio.tickDiff(last_tick, tick)))
            last_tick = tick
            last_level = level

        cb = None
        try:
            cb = pi.callback(self.gpio, self._pigpio.EITHER_EDGE, callback)
            pi.set_mode(self.gpio, self._pigpio.OUTPUT)
            pi.write(self.gpio, 0)
            time.sleep(0.018)
            pi.set_mode(self.gpio, self._pigpio.INPUT)
            pi.set_pull_up_down(self.gpio, self._pigpio.PUD_UP)

            deadline = time.monotonic() + self._read_timeout_seconds
            while time.monotonic() < deadline and len(high_pulses) < 41:
                time.sleep(0.005)
        except SensorDriverError:
            raise
        except PermissionError as exc:
            raise SensorDriverError("gpio-permission-denied", "Permission denied while accessing GPIO.") from exc
        except OSError as exc:
            raise _map_os_error(exc) from exc
        except Exception as exc:
            raise _map_backend_error(exc) from exc
        finally:
            if cb is not None:
                try:
                    cb.cancel()
                except Exception:
                    pass

        if not high_pulses:
            raise SensorDriverError("sensor-no-response", "No DHT22 response pulses were received.")
        if len(high_pulses) < 41:
            raise SensorDriverError("dht-timeout", "Timed out waiting for a complete DHT22 frame.")

        # The first high pulse is the DHT22 response; the following 40 pulses
        # are data bits. Typical bit high pulse widths are ~26us for 0 and
        # ~70us for 1, so 50us is a conservative split.
        for width_us in high_pulses[-40:]:
            bits.append(1 if width_us > 50 else 0)
        data = _bits_to_bytes(bits)
        if ((data[0] + data[1] + data[2] + data[3]) & 0xFF) != data[4]:
            raise SensorDriverError("dht-checksum", "DHT22 checksum mismatch.")

        humidity_raw = (data[0] << 8) | data[1]
        temperature_raw = ((data[2] & 0x7F) << 8) | data[3]
        humidity = humidity_raw / 10.0
        temperature = temperature_raw / 10.0
        if data[2] & 0x80:
            temperature = -temperature
        return RawEnvironmentalSample(temperature_c=temperature, humidity_pct=humidity, captured_at=utc_now())

    def _connect(self):
        if self._pi is not None:
            return self._pi
        pigpio = self._pigpio
        if pigpio is None:
            try:
                pigpio = importlib.import_module("pigpio")
            except Exception as exc:
                raise DriverUnavailableError("pigpio Python package is not installed.", code="backend-unavailable") from exc
            self._pigpio = pigpio
        try:
            self._pi = self._pi_factory() if self._pi_factory else pigpio.pi()
        except PermissionError as exc:
            raise SensorDriverError("gpio-permission-denied", "Permission denied while connecting to pigpio.") from exc
        except Exception as exc:
            raise _map_backend_error(exc) from exc
        if not getattr(self._pi, "connected", False):
            raise SensorDriverError("gpio-unavailable", "pigpio daemon is not reachable. Start pigpiod and retry.")
        return self._pi

    def close(self) -> None:
        if self._pi is not None:
            try:
                self._pi.stop()
            except Exception:
                pass
            self._pi = None


def backend_available() -> tuple[bool, str]:
    try:
        importlib.import_module("pigpio")
        return True, "pigpio Python package is importable"
    except Exception as exc:
        return False, f"pigpio Python package is not importable: {type(exc).__name__}"


def backend_ready() -> tuple[bool, str]:
    try:
        pigpio = importlib.import_module("pigpio")
    except Exception as exc:
        return False, f"pigpio Python package is not importable: {type(exc).__name__}"
    try:
        pi = pigpio.pi()
    except Exception as exc:
        return False, f"could not connect to pigpio daemon: {type(exc).__name__}"
    try:
        if getattr(pi, "connected", False):
            return True, "pigpio daemon is reachable"
        return False, "pigpio daemon is not reachable"
    finally:
        try:
            pi.stop()
        except Exception:
            pass


def _bits_to_bytes(bits: list[int]) -> list[int]:
    values: list[int] = []
    for offset in range(0, 40, 8):
        value = 0
        for bit in bits[offset : offset + 8]:
            value = (value << 1) | bit
        values.append(value)
    return values


def _map_os_error(exc: OSError) -> SensorDriverError:
    text = str(exc).lower()
    if "permission" in text:
        return SensorDriverError("gpio-permission-denied", "Permission denied while accessing GPIO.")
    if "busy" in text or "resource" in text:
        return SensorDriverError("gpio-busy", "GPIO line appears to be busy.")
    return SensorDriverError("gpio-unavailable", "GPIO access failed.")


def _map_backend_error(exc: Exception) -> SensorDriverError:
    text = str(exc).lower()
    if "permission" in text:
        return SensorDriverError("gpio-permission-denied", "Permission denied while accessing GPIO.")
    if "busy" in text or "resource" in text:
        return SensorDriverError("gpio-busy", "GPIO line appears to be busy.")
    if "connect" in text or "refused" in text or "daemon" in text:
        return SensorDriverError("gpio-unavailable", "pigpio daemon is not reachable.")
    return SensorDriverError("sensor-read-error", "DHT22 backend read failed.")
