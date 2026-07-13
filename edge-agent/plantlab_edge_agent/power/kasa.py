from __future__ import annotations

import asyncio
import importlib
import socket
from typing import Any, Optional

from .base import PowerDriverError

PINNED_KASA_SPEC = "python-kasa @ git+https://github.com/python-kasa/python-kasa.git@8b1f6b8c40588584f5d89df37e4610e2ece9a8cb"


class KasaPowerDriver:
    def __init__(self, host: str, username: str, password: str, alias_map: dict[str, str], timeout_seconds: float = 8):
        self.host = host
        self.username = username
        self.password = password
        self.alias_map = dict(alias_map)
        self.timeout_seconds = timeout_seconds
        self._loop = asyncio.new_event_loop()
        self._device: Any = None
        self._children_by_alias: dict[str, Any] = {}
        self.detected_model: Optional[str] = None
        self.detected_alias: Optional[str] = None
        self.detected_encryption: Optional[str] = None
        self.detected_login_version: Optional[str] = None

    def connect(self) -> None:
        if not self.username or not self.password:
            raise PowerDriverError("power-authentication-failed", "Kasa username/password are missing from greenhouse.env.")
        try:
            self._loop.run_until_complete(asyncio.wait_for(self._connect(), timeout=self.timeout_seconds))
        except PowerDriverError:
            raise
        except socket.gaierror as exc:
            raise PowerDriverError("power-host-unreachable", "Kasa host could not be resolved.") from exc
        except TimeoutError as exc:
            raise PowerDriverError("power-host-unreachable", "Timed out connecting to Kasa device.") from exc
        except Exception as exc:
            raise _map_kasa_exception(exc) from None

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
            self._loop.run_until_complete(self._device.update())
            return {logical: bool(_child_state(self._children_by_alias[alias])) for logical, alias in self.alias_map.items()}
        except Exception as exc:
            raise _map_kasa_exception(exc) from None

    def get_state(self, outlet: str) -> bool:
        return self.list_outlets()[outlet]

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
            self._loop.run_until_complete(method())
            self._loop.run_until_complete(self._device.update())
        except Exception as exc:
            raise _map_kasa_exception(exc) from None

    def _ensure_connected(self) -> None:
        if self._device is None:
            self.connect()


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
    text = str(exc).lower()
    if "auth" in text or "credential" in text or "login" in text:
        return PowerDriverError("power-authentication-failed", "Kasa authentication failed.")
    if "timeout" in text or "unreachable" in text or "no route" in text or "refused" in text:
        return PowerDriverError("power-host-unreachable", "Kasa host is unreachable.")
    return PowerDriverError("power-transport-error", "Kasa transport failed.")


def dependency_available() -> bool:
    try:
        _load_kasa_module()
        return True
    except PowerDriverError:
        return False
