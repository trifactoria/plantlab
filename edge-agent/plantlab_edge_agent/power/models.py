from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

OUTLET_KEYS = ("fans", "water", "lights")
OUTLET_BEHAVIORS = ("normal", "pulse-only")
DEFAULT_OUTLET_BEHAVIOR = "normal"
WATER_MAX_PULSE_SECONDS = 120


@dataclass(frozen=True)
class OutletState:
    key: str
    name: str
    provider: str
    provider_alias: str
    enabled: bool
    behavior: str
    safety_class: str
    actual_state: Optional[bool]
    state_observed_at: Optional[datetime]
    available: bool
    last_error_code: Optional[str] = None
    last_error_message: Optional[str] = None

    def to_wire(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "provider": self.provider,
            "providerAlias": self.provider_alias,
            "enabled": self.enabled,
            "behavior": self.behavior,
            "safetyClass": self.safety_class,
            "actualState": self.actual_state,
            "stateObservedAt": self.state_observed_at.isoformat().replace("+00:00", "Z") if self.state_observed_at else None,
            "available": self.available,
            "lastErrorCode": self.last_error_code,
            "lastErrorMessage": self.last_error_message,
        }


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def outlet_name(key: str) -> str:
    if key == "fans":
        return "Fans"
    if key == "water":
        return "Water"
    if key == "lights":
        return "Lights"
    return key


def safety_class_for_key(key: str) -> str:
    return "switch"


def behavior_or_default(value: Optional[str]) -> str:
    return value if value in OUTLET_BEHAVIORS else DEFAULT_OUTLET_BEHAVIOR
