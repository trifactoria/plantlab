"""Reliability hardening tests for the 2026-07-14 stuck-timer investigation.

Live evidence from the real hosts (plantlab/greenhouse-zero) showed the
edge agent's poll -> claim -> execute -> report pipeline is already fast
and healthy (~3-5 seconds end to end) - the actual incident root cause was
coordinator-side (see tests/unit/powerScheduleReliability.test.ts). These
tests cover the defense-in-depth hardening requested regardless: bounded
execution, retried transient failures, and command polling that isn't
starved by other subsystems.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from plantlab_edge_agent import config
from plantlab_edge_agent.power.base import PowerDriverError
from plantlab_edge_agent.power.runtime import PowerManager, poll_and_execute_power_command
from plantlab_edge_agent.protocol import AgentProtocolClient, ProtocolError


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


class RaisingPowerDriver(FakePowerDriver):
    """Simulates an unexpected (non-PowerDriverError) failure deep in the
    Kasa call stack - e.g. the get_state() KeyError gap this fix closed."""

    def get_state(self, outlet):
        raise KeyError(outlet)


def _cfg(tmp_path, fake_coordinator):
    return config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url=fake_coordinator["url"],
        spool_root=str(tmp_path / "spool"),
        capabilities=["relay", "fan", "light"],
        power=config.GreenhousePowerConfig(
            provider="kasa",
            host="192.168.1.72",
            outlets={"fans": "greenhouse-fans", "lights": "greenhouse-lights"},
        ),
    )


class _RaisingClient(AgentProtocolClient):
    """Wraps a real client but forces one named method to fail N times before delegating to the real implementation."""

    def __init__(self, inner: AgentProtocolClient, method: str, fail_times: int, error: Exception | None = None):
        self._inner = inner
        self._method = method
        self._fail_times = fail_times
        self._error = error or ProtocolError("simulated transient failure")
        self._calls = 0

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def next_power_command(self):
        if self._method == "next_power_command" and self._calls < self._fail_times:
            self._calls += 1
            raise self._error
        return self._inner.next_power_command()

    def claim_power_command(self, command_id):
        if self._method == "claim_power_command" and self._calls < self._fail_times:
            self._calls += 1
            raise self._error
        return self._inner.claim_power_command(command_id)

    def complete_power_command(self, command_id, actual_state, state_observed_at):
        if self._method == "complete_power_command" and self._calls < self._fail_times:
            self._calls += 1
            raise self._error
        return self._inner.complete_power_command(command_id, actual_state, state_observed_at)

    def fail_power_command(self, command_id, error_code, error_message, actual_state=None, state_observed_at=None):
        if self._method == "fail_power_command" and self._calls < self._fail_times:
            self._calls += 1
            raise self._error
        return self._inner.fail_power_command(command_id, error_code, error_message, actual_state, state_observed_at)


def test_transient_next_command_failure_does_not_crash_and_leaves_nothing_claimed(fake_coordinator, tmp_path):
    driver = FakePowerDriver()
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    real_client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    client = _RaisingClient(real_client, "next_power_command", fail_times=1)
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "cmd-a", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    poll_and_execute_power_command(cfg, client, manager)  # transient failure - should not raise

    assert fake_coordinator["state"].power_claimed == []
    assert driver.actions == []


def test_transient_claim_failure_does_not_execute_the_command(fake_coordinator, tmp_path):
    driver = FakePowerDriver()
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    real_client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    client = _RaisingClient(real_client, "claim_power_command", fail_times=1)
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "cmd-b", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    poll_and_execute_power_command(cfg, client, manager)

    assert driver.actions == []  # never executed - claim was not confirmed


def test_transient_completion_upload_failure_is_retried_and_eventually_succeeds(fake_coordinator, tmp_path):
    driver = FakePowerDriver({"fans": False})
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    real_client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    # Fails twice, succeeds on the 3rd attempt - within RESULT_UPLOAD_RETRY_ATTEMPTS.
    client = _RaisingClient(real_client, "complete_power_command", fail_times=2)
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "cmd-c", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    poll_and_execute_power_command(cfg, client, manager)

    assert fake_coordinator["state"].power_completed[0]["commandId"] == "cmd-c"
    assert fake_coordinator["state"].power_completed[0]["actualState"] is True


def test_completion_upload_failure_exhausting_retries_does_not_raise(fake_coordinator, tmp_path):
    driver = FakePowerDriver({"fans": False})
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    real_client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    # Always fails - exceeds the retry budget. The coordinator's stale-claim
    # recovery is the authoritative safety net in this case (see
    # powerProtocol.ts recoverStaleClaimedCommands); the edge loop must
    # simply not crash.
    client = _RaisingClient(real_client, "complete_power_command", fail_times=999)
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "cmd-d", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    poll_and_execute_power_command(cfg, client, manager)  # must not raise

    assert fake_coordinator["state"].power_completed == []


def test_unexpected_execution_error_still_reports_failure_instead_of_crashing(fake_coordinator, tmp_path):
    """Reproduces the get_state() KeyError gap this fix closed: an
    unexpected (non-PowerDriverError) exception deep in Kasa execution must
    resolve the command via fail_power_command, never propagate out and
    crash the whole agent loop leaving the command claimed forever."""
    driver = RaisingPowerDriver({"fans": False})
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "cmd-e", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )

    poll_and_execute_power_command(cfg, client, manager)  # must not raise

    assert fake_coordinator["state"].power_failed[0]["commandId"] == "cmd-e"
    assert fake_coordinator["state"].power_failed[0]["errorCode"] == "power-command-unexpected-error"


def test_get_state_missing_outlet_raises_power_driver_error_not_bare_keyerror(tmp_path, fake_coordinator):
    from plantlab_edge_agent.power.kasa import KasaPowerDriver

    driver = KasaPowerDriver(host="192.168.1.72", username="u", password="p", alias_map={"fans": "greenhouse-fans"})
    driver._children_by_alias = {}  # pretend connected but the alias vanished
    driver._device = object()

    with pytest.raises(PowerDriverError):
        driver.get_state("fans")


def test_healthy_heartbeat_but_no_pending_command_is_a_no_op(fake_coordinator, tmp_path):
    """A healthy edge node with nothing queued must do nothing and never
    claim/execute - guards against a regression that would claim a command
    that doesn't exist or spin needlessly."""
    driver = FakePowerDriver()
    cfg = _cfg(tmp_path, fake_coordinator)
    manager = PowerManager(cfg, driver_factory=lambda _power: driver)
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")

    poll_and_execute_power_command(cfg, client, manager)

    assert fake_coordinator["state"].power_claimed == []
    assert driver.actions == []


def test_command_poll_interval_stays_small(tmp_path, fake_coordinator):
    """Regression guard: normal scheduled-command latency depends on this
    staying at a small, "few seconds" scale default, not minutes."""
    cfg = _cfg(tmp_path, fake_coordinator)
    assert cfg.power_command_poll_interval_seconds <= 5


def test_command_polling_is_not_skipped_across_repeated_iterations_even_while_state_refresh_is_slow(fake_coordinator, tmp_path, isolated_config, monkeypatch):
    """Drives the real run_loop with a fake clock so a "slow" routine power
    state refresh (which normally runs right before the command poll in
    the loop body) cannot silently suppress or starve command polling
    across iterations - command polling must still happen on essentially
    every iteration once due, not just once at startup."""
    from plantlab_edge_agent import agent as agent_module

    class _FakeClock:
        def __init__(self, start: float = 1000.0):
            self.now = start

        def monotonic(self) -> float:
            return self.now

        def sleep(self, seconds: float) -> None:
            self.now += max(0.0, seconds)

    clock = _FakeClock()
    monkeypatch.setattr(agent_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(agent_module.time, "sleep", clock.sleep)

    cfg = replace(
        _cfg(tmp_path, fake_coordinator),
        power_command_poll_interval_seconds=1,
        power_state_refresh_interval_seconds=1,
        heartbeat_interval_seconds=100_000,
        camera_refresh_poll_interval_seconds=100_000,
        sensor_sample_interval_seconds=100_000,
        environment_upload_interval_seconds=100_000,
        poll_interval_seconds=100_000,
        spool_cleanup_interval_seconds=100_000,
    )
    config.write_config(cfg)
    config.write_credential("pln_validtoken")

    poll_calls: list[float] = []
    real_poll = agent_module.poll_and_execute_power_command

    def counting_poll(cfg_arg, client_arg, manager_arg):
        poll_calls.append(clock.now)
        return real_poll(cfg_arg, client_arg, manager_arg)

    def slow_upload_power_state(cfg_arg, client_arg, manager_arg, startup=False):
        clock.sleep(3.0)  # simulates a slow/near-hanging Kasa state refresh
        return True

    monkeypatch.setattr(agent_module, "poll_and_execute_power_command", counting_poll)
    monkeypatch.setattr(agent_module, "upload_power_state", slow_upload_power_state)

    iterations = {"count": 0}
    ITERATION_LIMIT = 12

    def stop_check() -> bool:
        iterations["count"] += 1
        return iterations["count"] > ITERATION_LIMIT

    agent_module.run_loop(stop_check=stop_check)

    # Command polling must have run on (almost) every iteration despite the
    # routine state refresh being repeatedly slow immediately beforehand in
    # the same loop body - it must not be silently skipped/absorbed.
    assert len(poll_calls) >= ITERATION_LIMIT - 2
