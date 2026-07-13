import pytest

from plantlab_edge_agent import config
from plantlab_edge_agent.power.base import PowerDriverError
from plantlab_edge_agent.power.runtime import PowerManager, poll_and_execute_power_command, upload_power_state
from plantlab_edge_agent.protocol import AgentProtocolClient, PowerCommand


class FakePowerDriver:
    def __init__(self, states=None, fail_connect=None):
        self.states = dict(states or {"fans": False, "water": False, "lights": False})
        self.fail_connect = fail_connect
        self.connected = False
        self.closed = False
        self.actions = []

    def connect(self):
        if self.fail_connect:
            raise PowerDriverError(self.fail_connect, "safe failure")
        self.connected = True

    def close(self):
        self.closed = True

    def list_outlets(self):
        return dict(self.states)

    def get_state(self, outlet):
        return self.states[outlet]

    def turn_on(self, outlet):
        self.actions.append(("on", outlet))
        self.states[outlet] = True

    def turn_off(self, outlet):
        self.actions.append(("off", outlet))
        self.states[outlet] = False


def _cfg(tmp_path, fake_coordinator=None):
    return config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url=fake_coordinator["url"] if fake_coordinator else "http://coordinator",
        spool_root=str(tmp_path / "spool"),
        capabilities=["relay", "fan", "light", "pump"],
        power=config.GreenhousePowerConfig(
            provider="kasa",
            host="192.168.1.72",
            outlets={"fans": "greenhouse-fans", "water": "greenhouse-water", "lights": "greenhouse-lights"},
        ),
    )


def test_refresh_states_reports_actual_outlets(tmp_path):
    driver = FakePowerDriver({"fans": True, "water": False, "lights": False})
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: driver)

    states = manager.refresh_states()

    assert [(state.key, state.provider_alias, state.actual_state, state.available) for state in states] == [
        ("fans", "greenhouse-fans", True, True),
        ("water", "greenhouse-water", False, True),
        ("lights", "greenhouse-lights", False, True),
    ]


def test_connection_failure_reports_unavailable_states(tmp_path):
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: FakePowerDriver(fail_connect="power-host-unreachable"))

    states = manager.refresh_states()

    assert all(state.available is False for state in states)
    assert {state.last_error_code for state in states} == {"power-host-unreachable"}


def test_on_off_verifies_actual_state(tmp_path):
    driver = FakePowerDriver({"fans": False})
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: driver)

    on = manager.execute(PowerCommand("cmd-1", "fans", "on", None, "later"))
    off = manager.execute(PowerCommand("cmd-2", "fans", "off", None, "later"))

    assert on.ok is True and on.actual_state is True
    assert off.ok is True and off.actual_state is False
    assert driver.actions == [("on", "fans"), ("off", "fans")]


def test_plain_water_on_is_rejected(tmp_path):
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: FakePowerDriver({"water": False}))

    result = manager.execute(PowerCommand("cmd-water", "water", "on", None, "later"))

    assert result.ok is False
    assert result.error_code == "power-configuration-invalid"


def test_water_pulse_turns_off_in_finally_when_verification_fails(tmp_path):
    class FailingAfterOn(FakePowerDriver):
        def get_state(self, outlet):
            if self.actions == [("on", "water")]:
                raise PowerDriverError("power-transport-error", "safe failure")
            return super().get_state(outlet)

    driver = FailingAfterOn({"water": False})
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: driver)

    result = manager.execute(PowerCommand("cmd-pulse", "water", "pulse", 1, "later"))

    assert result.ok is False
    assert ("off", "water") in driver.actions
    assert driver.states["water"] is False


def test_startup_unexpected_water_on_forces_off(tmp_path):
    driver = FakePowerDriver({"fans": False, "water": True, "lights": False})
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: driver)

    states = manager.startup_safety_check()

    assert ("off", "water") in driver.actions
    assert next(state for state in states if state.key == "water").actual_state is False


def test_power_state_upload_and_command_execution(fake_coordinator, tmp_path):
    driver = FakePowerDriver({"fans": False, "water": False, "lights": False})
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "power-runtime-1", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    assert upload_power_state(cfg, client, manager, startup=True) is True
    poll_and_execute_power_command(cfg, client, manager)

    assert fake_coordinator["state"].power_states
    assert fake_coordinator["state"].power_claimed == ["power-runtime-1"]
    assert fake_coordinator["state"].power_completed[0]["actualState"] is True


def test_water_pulse_duration_is_bounded(tmp_path):
    manager = PowerManager(_cfg(tmp_path), driver_factory=lambda _power: FakePowerDriver({"water": False}))

    result = manager.execute(PowerCommand("cmd-long", "water", "pulse", 999, "later"))

    assert result.ok is False
    assert result.error_code == "power-configuration-invalid"
