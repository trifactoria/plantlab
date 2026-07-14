from __future__ import annotations

from datetime import datetime, timezone

import pytest

from plantlab_edge_agent import __main__ as cli
from plantlab_edge_agent import config
from plantlab_edge_agent.power.base import PowerDriverError  # noqa: F401 - re-exported name parity, unused directly
from plantlab_edge_agent.protocol import AgentProtocolClient, ProtocolError
from plantlab_edge_agent.sensors.base import RawEnvironmentalSample, SensorDriverError
from plantlab_edge_agent.sensors.test_command_runtime import poll_and_execute_sensor_test
from plantlab_edge_agent.sensors.test_runner import run_bounded_sensor_test


def _cfg(fake_coordinator, sensors):
    return config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url=fake_coordinator["url"],
        spool_root="/tmp/unused-spool",
        capabilities=["temperature", "humidity"],
        sensors=sensors,
    )


def _sensor(key="greenhouse-middle", gpio=17, sensor_type="dht22"):
    return config.GreenhouseSensorConfig(key=key, name=key, type=sensor_type, gpio=gpio, placement=None, enabled=True)


class AlwaysFailDriver:
    def __init__(self, _sensor):
        pass

    def read(self):
        raise SensorDriverError("sensor-no-response", "No DHT22 response pulses were received.")

    def close(self):
        return None


class AlwaysPassDriver:
    def __init__(self, _sensor):
        pass

    def read(self):
        return RawEnvironmentalSample(24.0, 55.0, datetime(2026, 7, 14, 15, 30, tzinfo=timezone.utc))

    def close(self):
        return None


class RaisingUnexpectedDriver:
    def __init__(self, _sensor):
        pass

    def read(self):
        raise RuntimeError("boom")

    def close(self):
        return None


def test_run_bounded_sensor_test_reports_accepted_and_failed_counts():
    result = run_bounded_sensor_test(AlwaysPassDriver(None), _sensor(), attempts=3, interval=0)
    assert result.final_pass is True
    assert result.accepted_count == 3
    assert result.failed_count == 0
    assert len(result.attempts) == 3


def test_run_bounded_sensor_test_reports_total_failure():
    result = run_bounded_sensor_test(AlwaysFailDriver(None), _sensor(), attempts=5, interval=0)
    assert result.final_pass is False
    assert result.accepted_count == 0
    assert result.failed_count == 5
    assert all(outcome.code == "sensor-no-response" for outcome in result.attempts)


def test_poll_and_execute_sensor_test_full_success_lifecycle(fake_coordinator, monkeypatch):
    cfg = _cfg(fake_coordinator, [_sensor()])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_sensor_test_queue.append(
        {"id": "test-1", "sensorKey": "greenhouse-middle", "attemptsRequested": 2, "intervalSeconds": 0, "expiresAt": "2026-07-14T15:35:00Z"}
    )
    monkeypatch.setattr("plantlab_edge_agent.sensors.test_command_runtime.DHT22PigpioDriver", AlwaysPassDriver)

    poll_and_execute_sensor_test(cfg, client)

    state = fake_coordinator["state"]
    assert state.sensor_test_claimed == ["test-1"]
    assert state.sensor_test_started == ["test-1"]
    assert len(state.sensor_test_reported) == 1
    report = state.sensor_test_reported[0]
    assert report["finalPass"] is True
    assert report["acceptedCount"] == 2
    assert report["configuredGpio"] == 17


def test_poll_and_execute_sensor_test_reports_failure_verdict(fake_coordinator, monkeypatch):
    cfg = _cfg(fake_coordinator, [_sensor()])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_sensor_test_queue.append(
        {"id": "test-2", "sensorKey": "greenhouse-middle", "attemptsRequested": 3, "intervalSeconds": 0, "expiresAt": "2026-07-14T15:35:00Z"}
    )
    monkeypatch.setattr("plantlab_edge_agent.sensors.test_command_runtime.DHT22PigpioDriver", AlwaysFailDriver)

    poll_and_execute_sensor_test(cfg, client)

    report = fake_coordinator["state"].sensor_test_reported[0]
    assert report["finalPass"] is False
    assert report["failedCount"] == 3


def test_poll_and_execute_sensor_test_fails_for_unconfigured_sensor(fake_coordinator):
    cfg = _cfg(fake_coordinator, [_sensor(key="greenhouse-outside")])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_sensor_test_queue.append(
        {"id": "test-3", "sensorKey": "greenhouse-middle", "attemptsRequested": 2, "intervalSeconds": 0, "expiresAt": "2026-07-14T15:35:00Z"}
    )

    poll_and_execute_sensor_test(cfg, client)

    state = fake_coordinator["state"]
    assert state.sensor_test_claimed == ["test-3"]
    assert state.sensor_test_started == []  # never got to "running" - not configured
    assert state.sensor_test_failed[0]["errorCode"] == "sensor-not-configured"


def test_poll_and_execute_sensor_test_unexpected_exception_still_reports_failure(fake_coordinator, monkeypatch):
    cfg = _cfg(fake_coordinator, [_sensor()])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_sensor_test_queue.append(
        {"id": "test-4", "sensorKey": "greenhouse-middle", "attemptsRequested": 2, "intervalSeconds": 0, "expiresAt": "2026-07-14T15:35:00Z"}
    )

    def raising_factory(_sensor):
        raise RuntimeError("driver construction exploded")

    monkeypatch.setattr("plantlab_edge_agent.sensors.test_command_runtime.DHT22PigpioDriver", raising_factory)

    poll_and_execute_sensor_test(cfg, client)  # must not raise

    assert fake_coordinator["state"].sensor_test_failed[0]["errorCode"] == "sensor-test-unexpected-error"


def test_poll_and_execute_sensor_test_transient_poll_failure_does_not_crash(fake_coordinator, monkeypatch):
    cfg = _cfg(fake_coordinator, [_sensor()])

    class RaisingClient(AgentProtocolClient):
        def next_sensor_test(self):
            raise ProtocolError("transient")

    poll_and_execute_sensor_test(cfg, RaisingClient(fake_coordinator["url"], "pln_validtoken"))
    assert fake_coordinator["state"].sensor_test_claimed == []


def test_poll_and_execute_sensor_test_healthy_with_nothing_queued_is_a_no_op(fake_coordinator):
    cfg = _cfg(fake_coordinator, [_sensor()])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")

    poll_and_execute_sensor_test(cfg, client)

    state = fake_coordinator["state"]
    assert state.sensor_test_claimed == []
    assert state.sensor_test_reported == []


def test_doctor_all_sensors_continues_after_one_failure(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[_sensor(key="greenhouse-outside", gpio=2), _sensor(key="greenhouse-middle", gpio=17)],
        )
    )
    config.write_credential("pln_validtoken")

    def factory(sensor):
        return AlwaysPassDriver(sensor) if sensor.key == "greenhouse-outside" else AlwaysFailDriver(sensor)

    monkeypatch.setattr(cli, "DHT22PigpioDriver", factory)

    exit_code = cli.main(["doctor", "--all-sensors", "--attempts", "2", "--interval", "0"])

    output = capsys.readouterr().out
    assert "PASS greenhouse-outside" in output
    assert "FAIL greenhouse-middle:" in output
    assert exit_code == 1  # overall failure because one sensor failed, but both were tested


def test_doctor_sensor_flag_tests_only_that_sensor(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[_sensor(key="greenhouse-outside", gpio=2), _sensor(key="greenhouse-middle", gpio=17)],
        )
    )
    config.write_credential("pln_validtoken")
    monkeypatch.setattr(cli, "DHT22PigpioDriver", AlwaysPassDriver)
    # "mock" so the fast runtime checks don't depend on a real pigpiod being
    # reachable on the test machine - the hardware check below still goes
    # through the monkeypatched DHT22PigpioDriver regardless of this mode.
    monkeypatch.setenv("PLANTLAB_GREENHOUSE_SENSOR_DRIVER", "mock")

    exit_code = cli.main(["doctor", "--sensor", "greenhouse-outside", "--attempts", "1", "--interval", "0"])

    output = capsys.readouterr().out
    assert "PASS greenhouse-outside" in output
    assert "greenhouse-middle" not in output
    assert exit_code == 0


def test_default_doctor_reports_configured_healthy_failing_and_warns(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[_sensor(key="greenhouse-outside", gpio=2), _sensor(key="greenhouse-middle", gpio=17)],
        )
    )
    config.write_credential("pln_validtoken")
    fake_coordinator["state"].node_environment_response = {
        "sensors": [
            {"key": "greenhouse-outside", "latestClassification": "accepted"},
            {"key": "greenhouse-middle", "latestClassification": "failed"},
        ]
    }

    cli.main(["doctor"])

    output = capsys.readouterr().out
    assert "Configured sensors: 2" in output
    assert "Currently healthy: 1" in output
    assert "Currently failing: 1" in output
    assert "WARN: individual sensor failures detected" in output


def test_default_doctor_does_not_warn_when_all_sensors_healthy(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[_sensor(key="greenhouse-outside", gpio=2)],
        )
    )
    config.write_credential("pln_validtoken")
    fake_coordinator["state"].node_environment_response = {"sensors": [{"key": "greenhouse-outside", "latestClassification": "accepted"}]}

    cli.main(["doctor"])

    output = capsys.readouterr().out
    assert "Currently healthy: 1" in output
    assert "WARN" not in output
