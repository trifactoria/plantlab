import json
from datetime import datetime, timezone

from plantlab_edge_agent import __main__ as cli
from plantlab_edge_agent import config
from plantlab_edge_agent.sensors.base import RawEnvironmentalSample, SensorDriverError


def _write_ready_config(isolated_config, fake_coordinator):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["camera"],
        )
    )
    config.write_credential("pln_validtoken")


def test_config_show_never_prints_the_credential(isolated_config, fake_coordinator, capsys):
    _write_ready_config(isolated_config, fake_coordinator)

    assert cli.main(["config", "show"]) == 0
    output = capsys.readouterr().out
    assert "greenhouse-zero" in output
    assert "Credential present: yes" in output
    assert "pln_validtoken" not in output


def test_config_show_displays_greenhouse_sections_without_secrets(isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["camera", "temperature", "humidity", "relay", "fan"],
            sensors=[
                config.GreenhouseSensorConfig(
                    key="greenhouse-ambient",
                    name="Greenhouse ambient",
                    type="dht22",
                    gpio=4,
                    placement="Top shelf",
                    enabled=True,
                )
            ],
            power=config.GreenhousePowerConfig(provider="kasa", host="192.168.1.72", outlets={"fans": "greenhouse-fans"}),
        )
    )
    config.write_credential("pln_validtoken")
    (config.CONFIG_DIR / "greenhouse.env").write_text('KASA_USERNAME="user"\nKASA_PASSWORD="secret"\n')

    assert cli.main(["config", "show"]) == 0
    output = capsys.readouterr().out
    assert "Configured sensors: 1" in output
    assert "greenhouse-ambient" in output
    assert "BCM GPIO 4" in output
    assert "Power provider: kasa" in output
    assert "Sensor driver mode:" in output
    assert "fans=greenhouse-fans" in output
    assert "Greenhouse secret file: present" in output
    assert "KASA_PASSWORD" not in output
    assert 'KASA_PASSWORD="secret"' not in output


def test_config_show_reads_sensor_driver_mode_from_systemd_dropin(monkeypatch, isolated_config, fake_coordinator, tmp_path, capsys):
    monkeypatch.setenv("PLANTLAB_EDGE_SYSTEMD_USER_DIR", str(tmp_path))
    dropin_dir = tmp_path / "plantlab-edge-agent.service.d"
    dropin_dir.mkdir(parents=True)
    (dropin_dir / "greenhouse-sensor-driver.conf").write_text("[Service]\nEnvironment=PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22\n")
    _write_ready_config(isolated_config, fake_coordinator)

    assert cli.main(["config", "show"]) == 0
    output = capsys.readouterr().out
    assert "Configured sensor driver mode: dht22" in output
    assert "Current shell override: none" in output
    assert "Sensor driver mode: dht22" in output


def test_status_fails_when_coordinator_url_is_missing(isolated_config, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url="",
            spool_root=str(isolated_config / "spool"),
            capabilities=["camera"],
        )
    )
    config.write_credential("pln_validtoken")

    assert cli.main(["status"]) == 1
    output = capsys.readouterr().out
    assert "Coordinator: (not configured)" in output


def test_doctor_checks_coordinator_credential_and_heartbeat(isolated_config, fake_coordinator, capsys):
    _write_ready_config(isolated_config, fake_coordinator)

    assert cli.main(["doctor"]) == 0
    output = capsys.readouterr().out
    assert "PASS: coordinator-node-info" in output
    assert "PASS: credential-check" in output
    assert "PASS: heartbeat" in output
    assert fake_coordinator["state"].heartbeats


def test_doctor_resolves_dht22_mode_from_systemd_dropin(monkeypatch, isolated_config, fake_coordinator, tmp_path, capsys):
    monkeypatch.setenv("PLANTLAB_EDGE_SYSTEMD_USER_DIR", str(tmp_path))
    dropin_dir = tmp_path / "plantlab-edge-agent.service.d"
    dropin_dir.mkdir(parents=True)
    (dropin_dir / "greenhouse-sensor-driver.conf").write_text("[Service]\nEnvironment=PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22\n")
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[config.GreenhouseSensorConfig(key="greenhouse-ambient", name="Greenhouse Ambient", type="dht22", gpio=8, enabled=True)],
        )
    )
    config.write_credential("pln_validtoken")
    monkeypatch.setattr(cli.sensor_probe, "collect_probe", lambda _cfg: {"backendReady": True, "backendReadinessDetail": "pigpio daemon is reachable"})

    assert cli.main(["doctor"]) == 0
    output = capsys.readouterr().out
    assert "PASS: sensor-driver-mode: dht22" in output
    assert "PASS: dht22-backend: pigpio daemon is reachable" in output


def test_config_show_json_is_non_secret(isolated_config, fake_coordinator, capsys):
    _write_ready_config(isolated_config, fake_coordinator)

    assert cli.main(["config", "show", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["credentialPresent"] is True
    assert "pln_validtoken" not in json.dumps(payload)


def test_version_json_reports_package_commit_and_content_hash(capsys):
    assert cli.main(["version", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["command"] == "plantlab-edge"
    assert payload["version"]
    assert "commit" in payload
    assert len(payload["contentHash"]) == 64


def test_sensor_probe_json_reports_configured_sensor(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[config.GreenhouseSensorConfig(key="greenhouse-ambient", name="Greenhouse Ambient", type="dht22", gpio=8, placement="outside tent", enabled=True)],
        )
    )
    monkeypatch.setenv("PLANTLAB_GREENHOUSE_SENSOR_DRIVER", "dht22")

    assert cli.main(["sensor", "probe", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["selectedDriverMode"] == "dht22"
    assert payload["dht22Backend"] == "pigpio"
    assert payload["configuredSensors"][0]["gpio"] == 8


def test_sensor_probe_works_without_config(isolated_config, capsys):
    assert cli.main(["sensor", "probe", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["configuredSensors"] == []
    assert payload["dht22Backend"] == "pigpio"


def test_sensor_test_success_after_intermediate_failure(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[config.GreenhouseSensorConfig(key="greenhouse-ambient", name="Greenhouse Ambient", type="dht22", gpio=8, placement="outside tent", enabled=True)],
        )
    )

    class FakeDriver:
        def __init__(self, _sensor):
            self.calls = 0

        def read(self):
            self.calls += 1
            if self.calls == 1:
                raise SensorDriverError("dht-timeout", "Timed out waiting for a complete DHT22 frame.")
            return RawEnvironmentalSample(23.8, 64.2, datetime(2026, 7, 13, 15, 30, tzinfo=timezone.utc))

        def close(self):
            return None

    monkeypatch.setattr(cli, "DHT22PigpioDriver", FakeDriver)
    assert cli.main(["sensor", "test", "greenhouse-ambient", "--attempts", "2", "--interval", "0"]) == 0
    output = capsys.readouterr().out
    assert "Attempt 1/2: dht-timeout" in output
    assert "Attempt 2/2: 23.8 C, 64.2% RH - accepted" in output
    assert "PASS: 1 valid reading" in output


def test_sensor_test_unknown_disabled_and_all_failures(monkeypatch, isolated_config, fake_coordinator, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url=fake_coordinator["url"],
            spool_root=str(isolated_config / "spool"),
            capabilities=["temperature", "humidity"],
            sensors=[config.GreenhouseSensorConfig(key="disabled", name="Disabled", type="dht22", gpio=8, enabled=False), config.GreenhouseSensorConfig(key="bad", name="Bad", type="dht22", gpio=9, enabled=True)],
        )
    )
    assert cli.main(["sensor", "test", "missing", "--attempts", "1"]) == 1
    assert 'Unknown sensor "missing"' in capsys.readouterr().err
    assert cli.main(["sensor", "test", "disabled", "--attempts", "1"]) == 1
    assert 'Sensor "disabled" is disabled.' in capsys.readouterr().err

    class FailingDriver:
        def __init__(self, _sensor):
            pass

        def read(self):
            raise SensorDriverError("sensor-no-response", "No DHT22 response pulses were received.")

        def close(self):
            return None

    monkeypatch.setattr(cli, "DHT22PigpioDriver", FailingDriver)
    assert cli.main(["sensor", "test", "bad", "--attempts", "1", "--interval", "0"]) == 1
    assert "FAIL: no valid readings" in capsys.readouterr().out


def test_sensor_mode_writes_systemd_dropin(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PLANTLAB_EDGE_SYSTEMD_USER_DIR", str(tmp_path))
    dropin_dir = tmp_path / "plantlab-edge-agent.service.d"
    dropin_dir.mkdir(parents=True)
    (dropin_dir / "greenhouse-mock.conf").write_text("[Service]\nEnvironment=PLANTLAB_GREENHOUSE_SENSOR_DRIVER=mock\n")

    assert cli.main(["sensor", "mode", "dht22"]) == 0
    assert "Sensor driver mode set to dht22" in capsys.readouterr().out
    assert not (dropin_dir / "greenhouse-mock.conf").exists()
    assert "PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22" in (dropin_dir / "greenhouse-sensor-driver.conf").read_text()


def test_power_probe_does_not_print_credentials(monkeypatch, isolated_config, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url="http://coordinator",
            spool_root=str(isolated_config / "spool"),
            capabilities=["relay", "fan"],
            power=config.GreenhousePowerConfig(provider="kasa", host="192.168.1.72", outlets={"fans": "greenhouse-fans"}),
        )
    )
    config.GREENHOUSE_SECRET_PATH.write_text('KASA_USERNAME="user@example.com"\nKASA_PASSWORD="secret"\n')

    class FakeKasaDriver:
        detected_model = "KP303(US)"
        detected_encryption = "KLAP"
        detected_login_version = "2"

        def __init__(self, *_args, **_kwargs):
            pass

        def connect(self):
            return None

        def list_outlets(self):
            return {"fans": False}

        def close(self):
            return None

    monkeypatch.setattr(cli, "KasaPowerDriver", FakeKasaDriver)
    monkeypatch.setattr(cli, "kasa_dependency_available", lambda: True)
    monkeypatch.setattr(cli, "inspect_kasa_pin", lambda: type("Pin", (), {"status": "ready", "to_dict": lambda self: {"status": "ready", "source_type": "git", "repository": "https://github.com/python-kasa/python-kasa.git", "commit": "8b1f6b8c40588584f5d89df37e4610e2ece9a8cb", "import_path": "/venv/kasa/__init__.py"}})())
    monkeypatch.setattr(cli, "_classify_kasa_connectivity", lambda _host: "tcp-connectable")

    assert cli.main(["power", "probe"]) == 0
    output = capsys.readouterr().out
    assert "KP303" in output
    assert "Kasa dependency:" in output
    assert "status: ready" in output
    assert "greenhouse-fans" in output
    assert "user@example.com" not in output
    assert "secret" not in output


def test_power_status_and_manual_water_on(monkeypatch, isolated_config, capsys):
    config.write_config(
        config.EdgeAgentConfig(
            role="greenhouse-node",
            node_name="greenhouse-zero",
            coordinator_url="http://coordinator",
            spool_root=str(isolated_config / "spool"),
            capabilities=["relay", "pump"],
            power=config.GreenhousePowerConfig(provider="kasa", host="192.168.1.72", outlets={"water": "greenhouse-water"}, outlet_behaviors={"water": "normal"}),
        )
    )

    class FakeManager:
        def __init__(self, _cfg):
            pass

        def refresh_states(self):
            from plantlab_edge_agent.power.models import OutletState, utc_now

            return [OutletState("water", "Water", "kasa", "greenhouse-water", True, "normal", "switch", False, utc_now(), True)]

        def execute(self, command):
            return type("Result", (), {"ok": True, "actual_state": command.action == "on", "error_code": None, "error_message": None})()

        def close(self):
            return None

    monkeypatch.setattr(cli, "PowerManager", FakeManager)

    assert cli.main(["power", "status"]) == 0
    assert "greenhouse-water" in capsys.readouterr().out
    assert cli.main(["power", "on", "water"]) == 0
    assert "PASS: water verified ON" in capsys.readouterr().out
