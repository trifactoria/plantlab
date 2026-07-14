from plantlab_edge_agent import config
import pytest


def test_read_config_returns_none_when_missing(isolated_config):
    assert config.read_config() is None


def test_write_then_read_config_round_trips(isolated_config):
    written = config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url="http://coordinator:3000",
        spool_root=str(isolated_config / "spool"),
        capabilities=["camera"],
    )
    config.write_config(written)

    read_back = config.read_config()
    assert read_back is not None
    assert read_back.role == "greenhouse-node"
    assert read_back.node_name == "greenhouse-zero"
    assert read_back.coordinator_url == "http://coordinator:3000"
    assert read_back.capabilities == ["camera"]
    assert read_back.sensors == []
    assert read_back.power is None


def test_legacy_camera_only_config_loads(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        '{"role":"camera-node","nodeName":"cam","coordinatorUrl":"http://coordinator:3000","spoolRoot":"/tmp/spool","capabilities":["camera"]}\n'
    )

    read_back = config.read_config()

    assert read_back is not None
    assert read_back.role == "camera-node"
    assert read_back.capabilities == ["camera"]
    assert read_back.sensors == []
    assert read_back.power is None


def test_new_sensor_config_loads_and_derives_capabilities(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "sensors": [
    {"key": "greenhouse-ambient", "name": "Greenhouse ambient", "type": "dht22", "gpio": 4, "placement": "Top shelf", "enabled": true}
  ]
}
"""
    )

    read_back = config.read_config()

    assert read_back is not None
    assert read_back.sensors[0].key == "greenhouse-ambient"
    assert read_back.sensors[0].gpio == 4
    assert read_back.capabilities == ["camera", "temperature", "humidity"]


def test_new_power_config_loads_and_derives_capabilities(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "power": {
    "provider": "kasa",
    "host": "192.168.1.72",
    "outlets": {
      "fans": "greenhouse-fans",
      "water": "greenhouse-water",
      "lights": "greenhouse-lights"
    }
  }
}
"""
    )

    read_back = config.read_config()

    assert read_back is not None
    assert read_back.power is not None
    assert read_back.power.provider == "kasa"
    assert read_back.power.outlets["fans"] == "greenhouse-fans"
    assert read_back.power.outlet_behaviors == {"fans": "normal", "water": "normal", "lights": "normal"}
    assert read_back.capabilities == ["camera", "relay", "fan", "light", "pump"]


def test_power_config_accepts_explicit_outlet_behaviors(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "power": {
    "provider": "kasa",
    "host": "192.168.1.72",
    "outlets": {"water": "greenhouse-water"},
    "outletBehaviors": {"water": "pulse-only"}
  }
}
"""
    )

    read_back = config.read_config()

    assert read_back is not None
    assert read_back.power is not None
    assert read_back.power.outlet_behaviors == {"water": "pulse-only"}


def test_invalid_sensor_config_fails_clearly(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "sensors": [
    {"key": "a", "name": "A", "type": "dht22", "gpio": 4, "enabled": true},
    {"key": "b", "name": "B", "type": "dht22", "gpio": 4, "enabled": true}
  ]
}
"""
    )

    with pytest.raises(config.ConfigError, match="Duplicate BCM GPIO assignment 4"):
        config.read_config()


def test_invalid_power_config_fails_clearly(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "power": {"provider": "kasa", "host": "192.168.1.72", "outlets": {"fans": ""}}
}
"""
    )

    with pytest.raises(config.ConfigError, match="power.outlets.fans"):
        config.read_config()


def test_invalid_power_outlet_behavior_fails_clearly(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CONFIG_PATH.write_text(
        """
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "spoolRoot": "/tmp/spool",
  "capabilities": ["camera"],
  "power": {"provider": "kasa", "host": "192.168.1.72", "outlets": {"fans": "greenhouse-fans"}, "outletBehaviors": {"fans": "always-on"}}
}
"""
    )

    with pytest.raises(config.ConfigError, match="power.outletBehaviors.fans"):
        config.read_config()


def test_validate_config_rejects_missing_coordinator_url(isolated_config):
    cfg = config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url="",
        spool_root=str(isolated_config / "spool"),
        capabilities=["camera"],
    )
    assert "coordinatorUrl is missing." in config.validate_config(cfg)


def test_write_config_leaves_no_leftover_tmp_files(isolated_config):
    config.write_config(
        config.EdgeAgentConfig(role="camera-node", node_name="x", coordinator_url="http://c:3000", spool_root="/tmp/x", capabilities=["camera"])
    )
    leftovers = [p for p in isolated_config.iterdir() if ".tmp-" in p.name]
    assert leftovers == []


def test_read_credential_returns_none_when_file_missing(isolated_config):
    assert config.read_credential() is None


def test_read_credential_returns_none_for_empty_file(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CREDENTIAL_PATH.write_text("")
    assert config.read_credential() is None


def test_read_credential_returns_none_for_malformed_file_missing_the_variable(isolated_config):
    isolated_config.mkdir(parents=True, exist_ok=True)
    config.CREDENTIAL_PATH.write_text("SOME_OTHER_VAR=hello\n")
    assert config.read_credential() is None


def test_write_then_read_credential_round_trips_with_correct_permissions(isolated_config):
    config.write_credential("pln_abc123")
    assert config.read_credential() == "pln_abc123"

    mode = config.CREDENTIAL_PATH.stat().st_mode & 0o777
    assert mode == 0o600
    dir_mode = config.CONFIG_DIR.stat().st_mode & 0o777
    assert dir_mode == 0o700


def test_write_credential_leaves_no_leftover_tmp_files(isolated_config):
    config.write_credential("pln_xyz")
    leftovers = [p for p in isolated_config.iterdir() if ".tmp-" in p.name]
    assert leftovers == []


def test_never_touches_the_real_home_directory(isolated_config, tmp_path):
    """Part 15 'no access to real project data' - the isolated fixture must actually point somewhere under tmp_path, never a real $HOME."""
    assert str(config.CONFIG_DIR).startswith(str(tmp_path))
    assert str(config.CREDENTIAL_PATH).startswith(str(tmp_path))
