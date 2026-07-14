from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Callable, Optional

from .. import config
from ..protocol import AgentProtocolClient, PowerCommand, ProtocolError
from .base import PowerDriver, PowerDriverError
from .kasa import KasaPowerDriver
from .models import OUTLET_KEYS, WATER_MAX_PULSE_SECONDS, OutletState, outlet_name, safety_class_for_key, utc_now

logger = logging.getLogger("plantlab_edge_agent")

DriverFactory = Callable[[config.GreenhousePowerConfig], PowerDriver]


@dataclass
class PowerCommandExecution:
    ok: bool
    actual_state: Optional[bool]
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class PowerManager:
    def __init__(self, cfg: config.EdgeAgentConfig, driver_factory: Optional[DriverFactory] = None):
        self.cfg = cfg
        self.power_config = cfg.power
        self.driver_factory = driver_factory or default_driver_factory
        self.driver: Optional[PowerDriver] = None
        self.last_state_upload_at: float = 0
        self.next_connection_attempt_at: float = 0
        self.connection_backoff_seconds = 30
        self._last_reported_error: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self.power_config is not None and self.power_config.provider == "kasa" and bool(self.power_config.outlets)

    def close(self) -> None:
        if self.driver:
            self.driver.close()
            self.driver = None

    def configured_outlets(self) -> list[tuple[str, str]]:
        if not self.power_config:
            return []
        return [(key, self.power_config.outlets[key]) for key in OUTLET_KEYS if self.power_config.outlets.get(key)]

    def state_report_due(self, now: Optional[float] = None) -> bool:
        if not self.enabled:
            return False
        now = time.monotonic() if now is None else now
        return self.last_state_upload_at <= 0 or now - self.last_state_upload_at >= max(1, self.cfg.power_state_refresh_interval_seconds)

    def command_poll_due(self, now: Optional[float] = None) -> bool:
        if not self.enabled:
            return False
        now = time.monotonic() if now is None else now
        return now >= self.next_connection_attempt_at

    def refresh_states(self) -> list[OutletState]:
        if not self.enabled or not self.power_config:
            return []
        now = utc_now()
        try:
            driver = self._driver()
            states = driver.list_outlets()
            self._last_reported_error = None
            return [
                OutletState(
                    key=key,
                    name=outlet_name(key),
                    provider=self.power_config.provider,
                    provider_alias=alias,
                    enabled=True,
                    safety_class=safety_class_for_key(key),
                    actual_state=states.get(key),
                    state_observed_at=now,
                    available=key in states,
                )
                for key, alias in self.configured_outlets()
            ]
        except PowerDriverError as exc:
            self._mark_connection_failure(exc)
            return self._error_states(exc)

    def startup_safety_check(self) -> list[OutletState]:
        if not self.enabled or not self.power_config or "water" not in self.power_config.outlets:
            return self.refresh_states()
        try:
            driver = self._driver()
            states = driver.list_outlets()
            if states.get("water") is True:
                logger.warning("Water outlet was ON at startup; forcing OFF.")
                driver.turn_off("water")
                states = driver.list_outlets()
                if states.get("water") is not False:
                    raise PowerDriverError("power-state-verification-failed", "Water outlet did not verify OFF after startup safety shutoff.")
            self._last_reported_error = None
            return self.refresh_states()
        except PowerDriverError as exc:
            self._mark_connection_failure(exc)
            return self._error_states(exc)

    def execute(self, command: PowerCommand) -> PowerCommandExecution:
        if not self.enabled:
            return PowerCommandExecution(False, None, "power-configuration-invalid", "Power is not configured on this node.")
        if command.outlet_key == "water" and command.action == "on":
            return PowerCommandExecution(False, None, "power-configuration-invalid", "Water outlets do not permit unbounded ON commands.")
        if command.action == "pulse":
            return self._pulse(command.outlet_key, command.duration_seconds)
        if command.action == "on":
            return self._set(command.outlet_key, True)
        if command.action == "off":
            return self._set(command.outlet_key, False)
        if command.action == "refresh":
            states = self.refresh_states()
            state = next((item.actual_state for item in states if item.key == command.outlet_key), None)
            return PowerCommandExecution(True, state)
        return PowerCommandExecution(False, None, "power-configuration-invalid", f"Unsupported power action {command.action}.")

    def _set(self, outlet: str, desired: bool) -> PowerCommandExecution:
        try:
            driver = self._driver()
            if desired:
                driver.turn_on(outlet)
            else:
                driver.turn_off(outlet)
            actual = driver.get_state(outlet)
            if actual is not desired:
                return PowerCommandExecution(False, actual, "power-state-verification-failed", f"{outlet} did not verify {'ON' if desired else 'OFF'}.")
            logger.info("Power command verified: %s %s", outlet, "ON" if desired else "OFF")
            return PowerCommandExecution(True, actual)
        except PowerDriverError as exc:
            self._mark_connection_failure(exc)
            return PowerCommandExecution(False, None, exc.code, exc.safe_message)

    def _pulse(self, outlet: str, duration_seconds: Optional[int]) -> PowerCommandExecution:
        if outlet != "water":
            return PowerCommandExecution(False, None, "power-configuration-invalid", "Pulse is currently supported only for the water outlet.")
        if not isinstance(duration_seconds, int) or duration_seconds <= 0:
            return PowerCommandExecution(False, None, "power-configuration-invalid", "Water pulse duration must be greater than zero.")
        if duration_seconds > WATER_MAX_PULSE_SECONDS:
            return PowerCommandExecution(False, None, "power-configuration-invalid", f"Water pulse duration must be at most {WATER_MAX_PULSE_SECONDS} seconds.")
        driver: Optional[PowerDriver] = None
        try:
            driver = self._driver()
            driver.turn_on("water")
            actual_on = driver.get_state("water")
            if actual_on is not True:
                return PowerCommandExecution(False, actual_on, "power-state-verification-failed", "Water outlet did not verify ON before pulse.")
            try:
                time.sleep(duration_seconds)
            finally:
                driver.turn_off("water")
            actual_off = driver.get_state("water")
            if actual_off is not False:
                return PowerCommandExecution(False, actual_off, "power-state-verification-failed", "Water outlet did not verify OFF after pulse.")
            return PowerCommandExecution(True, False)
        except PowerDriverError as exc:
            self._mark_connection_failure(exc)
            if driver is not None:
                try:
                    driver.turn_off("water")
                except Exception:
                    pass
            return PowerCommandExecution(False, None, exc.code, exc.safe_message)

    def _driver(self) -> PowerDriver:
        if not self.power_config:
            raise PowerDriverError("power-configuration-invalid", "Power is not configured.")
        if self.driver is None:
            self.driver = self.driver_factory(self.power_config)
            self.driver.connect()
        return self.driver

    def _mark_connection_failure(self, exc: PowerDriverError) -> None:
        self.next_connection_attempt_at = time.monotonic() + self.connection_backoff_seconds
        if self._last_reported_error != exc.code:
            logger.warning("Power driver error: %s", exc.safe_message)
            self._last_reported_error = exc.code
        if self.driver is not None:
            try:
                self.driver.close()
            except Exception:
                pass
            self.driver = None

    def _error_states(self, exc: PowerDriverError) -> list[OutletState]:
        if not self.power_config:
            return []
        now = utc_now()
        return [
            OutletState(
                key=key,
                name=outlet_name(key),
                provider=self.power_config.provider,
                provider_alias=alias,
                enabled=True,
                safety_class=safety_class_for_key(key),
                actual_state=None,
                state_observed_at=now,
                available=False,
                last_error_code=exc.code,
                last_error_message=exc.safe_message,
            )
            for key, alias in self.configured_outlets()
        ]


def default_driver_factory(power_config: config.GreenhousePowerConfig) -> PowerDriver:
    secrets = config.read_greenhouse_secrets()
    return KasaPowerDriver(
        host=power_config.host,
        username=secrets.get("KASA_USERNAME", ""),
        password=secrets.get("KASA_PASSWORD", ""),
        alias_map=power_config.outlets,
    )


def upload_power_state(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, manager: PowerManager, startup: bool = False) -> bool:
    states = manager.startup_safety_check() if startup else manager.refresh_states()
    if not states:
        return False
    try:
        client.post_power_state(cfg.node_name, [state.to_wire() for state in states])
        manager.last_state_upload_at = time.monotonic()
        logger.info("Power outlet state uploaded: %d outlet(s)", len(states))
        return True
    except ProtocolError as exc:
        logger.warning("Power state upload failed: %s", exc)
        return False


def poll_and_execute_power_command(cfg: config.EdgeAgentConfig, client: AgentProtocolClient, manager: PowerManager) -> None:
    if not manager.enabled:
        return
    try:
        command = client.next_power_command()
    except ProtocolError as exc:
        logger.warning("Power command poll failed: %s", exc)
        return
    if command is None:
        return
    try:
        client.claim_power_command(command.id)
    except ProtocolError as exc:
        logger.warning("Could not claim power command %s: %s", command.id, exc)
        return
    result = manager.execute(command)
    observed_at = utc_now().isoformat().replace("+00:00", "Z")
    try:
        if result.ok:
            client.complete_power_command(command.id, result.actual_state, observed_at)
        else:
            client.fail_power_command(command.id, result.error_code or "power-command-failed", result.error_message or "Power command failed.", result.actual_state, observed_at)
    except ProtocolError as exc:
        logger.warning("Power command acknowledgement failed: command=%s error=%s", command.id, exc)
