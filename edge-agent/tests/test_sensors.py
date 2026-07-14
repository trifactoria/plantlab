from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest

from plantlab_edge_agent import config
from plantlab_edge_agent.sensors.base import RawEnvironmentalSample, SensorDriverError
from plantlab_edge_agent.sensors.dht22 import DHT22PigpioDriver
from plantlab_edge_agent.sensors.mock import DriverUnavailableError, MockEnvironmentalSensorDriver, UnavailableEnvironmentalSensorDriver
from plantlab_edge_agent.sensors.runtime import EnvironmentalSensorManager, EnvironmentalSensorRuntime, selected_driver_mode
from plantlab_edge_agent.sensors.validation import EnvironmentalSampleValidator, ValidationConfig


def sensor(key="greenhouse-ambient", gpio=4):
    return config.GreenhouseSensorConfig(key=key, name=key, type="dht22", gpio=gpio, placement="Top shelf", enabled=True)


def dt(seconds=0):
    return datetime(2026, 7, 13, 15, 30, seconds, tzinfo=timezone.utc)


def sample(temp, humidity, seconds=0):
    return RawEnvironmentalSample(temp, humidity, dt(seconds))


def classifications(events):
    return [event.classification for event in events]


def fixture(name):
    root = Path(__file__).resolve().parents[2] / "test-fixtures" / "greenhouse"
    return json.loads((root / name).read_text(encoding="utf-8"))


def test_shared_greenhouse_fixtures_load_into_python_config():
    raw = fixture("valid-multi-sensor-config.json")
    sensors = config.parse_sensors(raw["sensors"])
    assert [sensor.key for sensor in sensors] == ["greenhouse-ambient", "propagation-tray"]


def test_mock_driver_realistic_sample():
    driver = MockEnvironmentalSensorDriver("s1")
    first = driver.read()
    second = driver.read()
    assert 20 <= first.temperature_c <= 28
    assert 55 <= first.humidity_pct <= 75
    assert first != second


def test_mock_driver_injected_failure():
    driver = MockEnvironmentalSensorDriver("s1")
    driver.inject_failure("boom")
    with pytest.raises(RuntimeError):
        driver.read()


def test_hard_bound_rejection():
    validator = EnvironmentalSampleValidator(sensor())
    events = validator.evaluate(sample(81, 50))
    assert classifications(events) == ["rejected"]
    assert events[0].diagnostic_code == "temperature-hard-bound"
    assert events[0].temperature_c is None
    assert events[0].humidity_pct is None


def test_plausible_bound_suspect():
    validator = EnvironmentalSampleValidator(sensor())
    events = validator.evaluate(sample(-1, 50))
    assert classifications(events) == ["suspect"]
    assert events[0].diagnostic_code == "temperature-plausible-bound"


def test_temperature_and_humidity_jump_suspect():
    validator = EnvironmentalSampleValidator(sensor())
    assert classifications(validator.evaluate(sample(24, 60))) == ["accepted"]
    assert validator.evaluate(sample(33, 60, 1))[0].diagnostic_code == "temperature-sudden-change"
    validator = EnvironmentalSampleValidator(sensor())
    assert classifications(validator.evaluate(sample(24, 60))) == ["accepted"]
    assert validator.evaluate(sample(24, 90, 1))[0].diagnostic_code == "humidity-sudden-change"


def test_confirmation_accepts_new_baseline():
    validator = EnvironmentalSampleValidator(sensor())
    assert classifications(validator.evaluate(sample(24, 60))) == ["accepted"]
    assert classifications(validator.evaluate(sample(33, 80, 1))) == ["suspect"]
    events = validator.evaluate(sample(34, 82, 2))
    assert classifications(events) == ["accepted"]
    assert validator.state.last_accepted_temperature_c == 34


def test_unconfirmed_spike_rejected_and_baseline_sample_accepted():
    validator = EnvironmentalSampleValidator(sensor())
    assert classifications(validator.evaluate(sample(24, 60))) == ["accepted"]
    assert classifications(validator.evaluate(sample(36, 90, 1))) == ["suspect"]
    events = validator.evaluate(sample(24.5, 61, 2))
    assert classifications(events) == ["rejected", "accepted"]
    assert events[0].diagnostic_code == "isolated-spike"


def test_nan_and_infinity_rejection():
    validator = EnvironmentalSampleValidator(sensor())
    assert validator.evaluate(sample(float("nan"), 50))[0].diagnostic_code == "invalid-number"
    assert validator.evaluate(sample(20, float("inf")))[0].diagnostic_code == "invalid-number"


def test_failure_and_reject_counters_and_recovery_from_stale():
    runtime = EnvironmentalSensorRuntime(sensor(), UnavailableEnvironmentalSensorDriver("missing"), ValidationConfig(stale_timeout_seconds=1), continuing_diagnostic_interval_seconds=1)
    assert runtime.sample_once(dt(0))[0].classification == "driver-unavailable"
    assert runtime.validator.state.consecutive_driver_failures == 1

    validator = EnvironmentalSampleValidator(sensor(), ValidationConfig(stale_timeout_seconds=1))
    validator.evaluate(sample(24, 60, 0))
    stale = validator.stale_event_if_due(dt(2))
    assert stale is not None
    assert stale.classification == "stale"
    assert validator.evaluate(sample(24, 60, 3))[0].classification == "accepted"
    assert validator.state.stale_reported is False

    validator.evaluate(sample(90, 60, 4))
    assert validator.state.consecutive_validation_rejects == 1


def test_diagnostic_deduplication():
    runtime = EnvironmentalSensorRuntime(sensor(), UnavailableEnvironmentalSensorDriver("missing"), continuing_diagnostic_interval_seconds=300)
    assert len(runtime.sample_once(dt(0))) == 1
    assert runtime.sample_once(dt(1)) == []
    assert len(runtime.sample_once(dt(0) + timedelta(seconds=301))) == 1


def test_event_id_stability():
    validator = EnvironmentalSampleValidator(sensor())
    first = validator.evaluate(sample(24, 60))[0]
    validator = EnvironmentalSampleValidator(sensor())
    second = validator.evaluate(sample(24, 60))[0]
    assert first.event_id == second.event_id


def test_multiple_sensors_have_independent_state():
    a = EnvironmentalSampleValidator(sensor("a", 4))
    b = EnvironmentalSampleValidator(sensor("b", 5))
    a.evaluate(sample(24, 60))
    b.evaluate(sample(24, 60))
    assert a.evaluate(sample(36, 90, 1))[0].classification == "suspect"
    assert b.evaluate(sample(24, 60, 1))[0].classification == "accepted"
    assert a.state.pending_suspect is not None
    assert b.state.pending_suspect is None


class FakeCallback:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


class FakePigpio:
    EITHER_EDGE = 2
    OUTPUT = 1
    INPUT = 0
    PUD_UP = 2

    @staticmethod
    def tickDiff(start, end):
        return end - start


class FakePi:
    connected = True

    def __init__(self, high_pulses=None, error=None):
        self.high_pulses = high_pulses or []
        self.error = error
        self.callback_fn = None
        self.stopped = False

    def callback(self, _gpio, _edge, fn):
        self.callback_fn = fn
        return FakeCallback()

    def set_mode(self, gpio, mode):
        if self.error:
            raise self.error
        if mode == FakePigpio.INPUT and self.callback_fn:
            tick = 0
            for width in self.high_pulses:
                self.callback_fn(gpio, 1, tick)
                tick += width
                self.callback_fn(gpio, 0, tick)
                tick += 50

    def write(self, _gpio, _level):
        return None

    def set_pull_up_down(self, _gpio, _pud):
        return None

    def stop(self):
        self.stopped = True


def pulses_for_bytes(values):
    pulses = [80]
    for value in values:
        for shift in range(7, -1, -1):
            pulses.append(70 if value & (1 << shift) else 26)
    return pulses


def test_dht22_driver_decodes_pigpio_edges():
    data = [0x02, 0x82, 0x00, 0xEE, (0x02 + 0x82 + 0x00 + 0xEE) & 0xFF]
    fake_pi = FakePi(pulses_for_bytes(data))
    driver = DHT22PigpioDriver(sensor(gpio=8), pigpio_module=FakePigpio, pi_factory=lambda: fake_pi, read_timeout_seconds=0.01, settle_seconds=0)

    raw = driver.read()
    driver.close()

    assert raw.temperature_c == pytest.approx(23.8)
    assert raw.humidity_pct == pytest.approx(64.2)
    assert fake_pi.stopped is True


def test_dht22_driver_maps_checksum_timeout_and_permission_errors():
    bad = [0x02, 0x82, 0x00, 0xEE, 0x00]
    with pytest.raises(SensorDriverError, match="checksum") as checksum:
        DHT22PigpioDriver(sensor(), pigpio_module=FakePigpio, pi_factory=lambda: FakePi(pulses_for_bytes(bad)), read_timeout_seconds=0.01, settle_seconds=0).read()
    assert checksum.value.code == "dht-checksum"

    with pytest.raises(SensorDriverError) as timeout:
        DHT22PigpioDriver(sensor(), pigpio_module=FakePigpio, pi_factory=lambda: FakePi([80, 26]), read_timeout_seconds=0.01, settle_seconds=0).read()
    assert timeout.value.code == "dht-timeout"

    with pytest.raises(SensorDriverError) as permission:
        DHT22PigpioDriver(sensor(), pigpio_module=FakePigpio, pi_factory=lambda: FakePi(error=PermissionError("denied")), read_timeout_seconds=0.01, settle_seconds=0).read()
    assert permission.value.code == "gpio-permission-denied"


def test_dht22_driver_reports_backend_unavailable_without_mock_fallback(monkeypatch):
    import importlib

    def fail_import(_name):
        raise ImportError("missing")

    monkeypatch.setattr(importlib, "import_module", fail_import)
    with pytest.raises(DriverUnavailableError) as unavailable:
        DHT22PigpioDriver(sensor()).read()
    assert unavailable.value.code == "backend-unavailable"


def test_driver_mode_selection_and_manager(monkeypatch):
    cfg = config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url="http://coordinator:3000",
        spool_root="/tmp/spool",
        capabilities=["temperature", "humidity"],
        sensors=[sensor()],
    )
    assert selected_driver_mode({}) == "unavailable"
    assert selected_driver_mode({"PLANTLAB_GREENHOUSE_SENSOR_DRIVER": "DHT22"}) == "dht22"

    monkeypatch.setenv("PLANTLAB_GREENHOUSE_SENSOR_DRIVER", "mock")
    assert EnvironmentalSensorManager.from_config(cfg).sample_due(dt(0))[0].classification == "accepted"

    monkeypatch.setenv("PLANTLAB_GREENHOUSE_SENSOR_DRIVER", "disabled")
    assert EnvironmentalSensorManager.from_config(cfg).runtimes == []

    monkeypatch.setenv("PLANTLAB_GREENHOUSE_SENSOR_DRIVER", "bad")
    with pytest.raises(ValueError):
        EnvironmentalSensorManager.from_config(cfg)


def test_sensor_manager_does_not_read_between_due_intervals():
    class CountingDriver:
        def __init__(self):
            self.reads = 0

        def read(self):
            self.reads += 1
            return sample(24, 60)

        def close(self):
            return None

    driver = CountingDriver()
    manager = EnvironmentalSensorManager([EnvironmentalSensorRuntime(sensor(), driver)], sample_interval_seconds=15, upload_interval_seconds=45)
    assert len(manager.sample_due(dt(0))) == 1
    assert manager.sample_due(dt(1)) == []
    assert manager.sample_due(dt(14)) == []
    assert driver.reads == 1
    assert len(manager.sample_due(dt(15))) == 1
    assert driver.reads == 2
