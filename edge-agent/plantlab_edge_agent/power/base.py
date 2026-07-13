from __future__ import annotations

from typing import Protocol


class PowerDriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.safe_message = message


class PowerDriver(Protocol):
    def connect(self) -> None:
        ...

    def close(self) -> None:
        ...

    def list_outlets(self) -> dict[str, bool]:
        ...

    def get_state(self, outlet: str) -> bool:
        ...

    def turn_on(self, outlet: str) -> None:
        ...

    def turn_off(self, outlet: str) -> None:
        ...
