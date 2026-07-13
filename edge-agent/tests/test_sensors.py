from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest

from plantlab_edge_agent import config
from plantlab_edge_agent.sensors.base import RawEnvironmentalSample
from plantlab_edge_agent.sensors.mock import MockEnvironmentalSensorDriver, UnavailableEnvironmentalSensorDriver
from plantlab_edge_agent.sensors.runtime import EnvironmentalSensorRuntime
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
