from plantlab_edge_agent import config


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
