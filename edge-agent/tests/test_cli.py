import json

from plantlab_edge_agent import __main__ as cli
from plantlab_edge_agent import config


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


def test_config_show_json_is_non_secret(isolated_config, fake_coordinator, capsys):
    _write_ready_config(isolated_config, fake_coordinator)

    assert cli.main(["config", "show", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["credentialPresent"] is True
    assert "pln_validtoken" not in json.dumps(payload)
