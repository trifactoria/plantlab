from __future__ import annotations

import asyncio
import errno
import importlib
import socket
import time
from typing import Any, Optional

from .base import PowerDriverError
from .dependencies import KASA_PIN_READY, KASA_SPEC, inspect_kasa_pin

PINNED_KASA_SPEC = KASA_SPEC


class KasaPowerDriver:
    def __init__(self, host: str, username: str, password: str, alias_map: dict[str, str], timeout_seconds: float = 8, connect_attempts: int = 2):
        self.host = host
        self.username = username
        self.password = password
        self.alias_map = dict(alias_map)
        self.timeout_seconds = timeout_seconds
        self.connect_attempts = max(1, int(connect_attempts))
        self._loop = asyncio.new_event_loop()
        self._device: Any = None
        self._children_by_alias: dict[str, Any] = {}
        self.detected_model: Optional[str] = None
        self.detected_alias: Optional[str] = None
        self.detected_encryption: Optional[str] = None
        self.detected_login_version: Optional[str] = None
        self._last_states: dict[str, bool] = {}

    def connect(self) -> None:
        if not self.username or not self.password:
            raise PowerDriverError("power-authentication-failed", "Kasa username/password are missing from greenhouse.env.")
        last_error: PowerDriverError | None = None
        for attempt in range(1, self.connect_attempts + 1):
            try:
                self._run(self._connect())
                return
            except Exception as exc:
                mapped = _map_connect_exception(exc)
                if not _is_transient_connect_error(mapped) or attempt >= self.connect_attempts:
                    raise mapped from None
                last_error = mapped
                self._reset_after_failed_connect()
                time.sleep(min(1.0, 0.2 * attempt))
        if last_error:
            raise last_error

    async def _connect(self) -> None:
        kasa = _load_kasa_module()
        credentials = kasa.Credentials(self.username, self.password)
        config = kasa.DeviceConfig(host=self.host, credentials=credentials)
        device = await kasa.Device.connect(config=config)
        await device.update()
        self._device = device
        self.detected_model = str(getattr(device, "model", "") or getattr(device, "device_type", "") or "").strip() or None
        self.detected_alias = str(getattr(device, "alias", "") or "").strip() or None
        protocol = getattr(device, "protocol", None)
        transport = getattr(protocol, "transport", None) if protocol is not None else None
        self.detected_encryption = str(getattr(transport, "encryption_type", "") or getattr(transport, "transport_type", "") or "").strip() or None
        self.detected_login_version = str(getattr(transport, "login_version", "") or "").strip() or None
        self._children_by_alias = _children_by_alias(device)
        missing = [alias for alias in self.alias_map.values() if alias not in self._children_by_alias]
        if missing:
            raise PowerDriverError("power-outlet-missing", f"Configured Kasa outlet alias was not found: {', '.join(sorted(missing))}.")

    def close(self) -> None:
        try:
            if self._device is not None:
                close = getattr(self._device, "disconnect", None) or getattr(self._device, "close", None)
                if close:
                    result = close()
                    if asyncio.iscoroutine(result):
                        self._loop.run_until_complete(result)
        finally:
            self._device = None
            self._children_by_alias = {}
            if not self._loop.is_closed():
                self._loop.close()

    def list_outlets(self) -> dict[str, bool]:
        self._ensure_connected()
        try:
            return self._refresh_states()
        except Exception as exc:
            raise _map_kasa_exception(exc) from None

    def get_state(self, outlet: str) -> bool:
        if outlet in self._last_states:
            return self._last_states[outlet]
        try:
            return self.list_outlets()[outlet]
        except KeyError:
            raise PowerDriverError("power-outlet-missing", f"Configured outlet {outlet} is missing from the Kasa device.") from None

    def turn_on(self, outlet: str) -> None:
        self._set_state(outlet, True)

    def turn_off(self, outlet: str) -> None:
        self._set_state(outlet, False)

    def _set_state(self, outlet: str, desired: bool) -> None:
        self._ensure_connected()
        alias = self.alias_map.get(outlet)
        child = self._children_by_alias.get(alias or "")
        if child is None:
            raise PowerDriverError("power-outlet-missing", f"Configured outlet {outlet} is missing from the Kasa device.")
        try:
            method = child.turn_on if desired else child.turn_off
            self._run(method())
            self._refresh_states()
        except Exception as exc:
            raise _map_kasa_exception(exc) from None

    def _ensure_connected(self) -> None:
        if self._device is None:
            self.connect()

    def _refresh_states(self) -> dict[str, bool]:
        self._run(self._device.update())
        self._last_states = {logical: bool(_child_state(self._children_by_alias[alias])) for logical, alias in self.alias_map.items()}
        return dict(self._last_states)

    def _run(self, awaitable: Any):
        return self._loop.run_until_complete(asyncio.wait_for(awaitable, timeout=self.timeout_seconds))

    def _reset_after_failed_connect(self) -> None:
        self._device = None
        self._children_by_alias = {}
        self._last_states = {}
        if not self._loop.is_closed():
            self._loop.close()
        self._loop = asyncio.new_event_loop()


def _load_kasa_module():
    try:
        kasa = importlib.import_module("kasa")
        for attr in ("Device", "DeviceConfig", "Credentials"):
            if not hasattr(kasa, attr):
                raise AttributeError(attr)
        return kasa
    except Exception as exc:
        raise PowerDriverError("power-driver-unavailable", "python-kasa is not installed or does not expose the required KLAP-capable API.") from exc


def _children_by_alias(device: Any) -> dict[str, Any]:
    children = getattr(device, "children", None)
    if children is None:
        children = getattr(device, "modules", {}).get("child_device", None)
    if isinstance(children, dict):
        iterable = children.values()
    elif isinstance(children, (list, tuple)):
        iterable = children
    else:
        iterable = []
    result: dict[str, Any] = {}
    for child in iterable:
        alias = getattr(child, "alias", None) or getattr(child, "name", None)
        if isinstance(alias, str) and alias:
            result[alias] = child
    return result


def _child_state(child: Any) -> bool:
    if hasattr(child, "is_on"):
        return bool(getattr(child, "is_on"))
    if hasattr(child, "state"):
        state = getattr(child, "state")
        if isinstance(state, bool):
            return state
        if isinstance(state, str):
            return state.lower() == "on"
    raise PowerDriverError("power-transport-error", "Kasa child outlet did not expose a readable state.")


def _map_kasa_exception(exc: Exception) -> PowerDriverError:
    if isinstance(exc, PowerDriverError):
        return exc
    if isinstance(exc, ConnectionRefusedError):
        return PowerDriverError("power-connection-refused", "Kasa host refused the connection.")
    if isinstance(exc, TimeoutError):
        return PowerDriverError("power-connection-timeout", "Timed out connecting to Kasa device.")
    if isinstance(exc, OSError):
        mapped = _map_os_error(exc)
        if mapped:
            return mapped
    text = str(exc).lower()
    if "auth" in text or "credential" in text or "invalid username" in text or "invalid password" in text:
        return PowerDriverError("power-authentication-failed", "Kasa authentication failed.")
    if "refused" in text:
        return PowerDriverError("power-connection-refused", "Kasa host refused the connection.")
    if "timeout" in text or "timed out" in text:
        return PowerDriverError("power-connection-timeout", "Timed out connecting to Kasa device.")
    if "unreachable" in text or "no route" in text or "network is down" in text:
        return PowerDriverError("power-host-unreachable", "Kasa host is unreachable.")
    if "transport" in text or "klap" in text or "protocol" in text:
        return PowerDriverError("power-transport-selection-failed", "Kasa transport selection failed.")
    if "offline" in text or "device not found" in text:
        return PowerDriverError("power-device-offline", "Kasa device appears to be offline.")
    return PowerDriverError("power-transport-error", "Kasa transport failed.")


def _map_connect_exception(exc: Exception) -> PowerDriverError:
    if isinstance(exc, PowerDriverError):
        return exc
    if isinstance(exc, socket.gaierror):
        return PowerDriverError("power-host-unreachable", "Kasa host could not be resolved.")
    return _map_kasa_exception(exc)


def _is_transient_connect_error(exc: PowerDriverError) -> bool:
    return exc.code in {
        "power-connection-timeout",
        "power-host-unreachable",
        "power-transport-error",
        "power-transport-selection-failed",
        "power-device-offline",
    }


def _map_os_error(exc: OSError) -> PowerDriverError | None:
    code = getattr(exc, "errno", None)
    if code in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.ENETDOWN):
        return PowerDriverError("power-host-unreachable", "Kasa host is unreachable.")
    if code == errno.ECONNREFUSED:
        return PowerDriverError("power-connection-refused", "Kasa host refused the connection.")
    if code == errno.ETIMEDOUT:
        return PowerDriverError("power-connection-timeout", "Timed out connecting to Kasa device.")
    return None


def dependency_available() -> bool:
    return inspect_kasa_pin().status == KASA_PIN_READY
