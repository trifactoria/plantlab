from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from ..config import GreenhouseSensorConfig
from .base import (
    CLASSIFICATION_ACCEPTED,
    CLASSIFICATION_REJECTED,
    CLASSIFICATION_STALE,
    CLASSIFICATION_SUSPECT,
    RawEnvironmentalSample,
    SensorTelemetryEvent,
)


@dataclass(frozen=True)
class Range:
    min: float
    max: float

    def contains(self, value: float) -> bool:
        return self.min <= value <= self.max


@dataclass(frozen=True)
class ValidationConfig:
    hard_temperature_c: Range = Range(-40.0, 80.0)
    hard_humidity_pct: Range = Range(0.0, 100.0)
    plausible_temperature_c: Range = Range(0.0, 50.0)
    plausible_humidity_pct: Range = Range(5.0, 100.0)
    sudden_temperature_delta_c: float = 8.0
    sudden_humidity_delta_pct: float = 25.0
    confirmation_temperature_delta_c: float = 2.0
    confirmation_humidity_delta_pct: float = 8.0
    confirmation_period_seconds: int = 60
    stale_timeout_seconds: int = 45


@dataclass
class PendingSuspect:
    event: SensorTelemetryEvent


@dataclass
class SensorValidationState:
    last_attempt_at: Optional[datetime] = None
    last_accepted_at: Optional[datetime] = None
    last_accepted_temperature_c: Optional[float] = None
    last_accepted_humidity_pct: Optional[float] = None
    consecutive_driver_failures: int = 0
    consecutive_validation_rejects: int = 0
    pending_suspect: Optional[PendingSuspect] = None
    latest_diagnostic_code: Optional[str] = None
    latest_classification: Optional[str] = None
    stale_reported: bool = False


class EnvironmentalSampleValidator:
    def __init__(self, sensor: GreenhouseSensorConfig, config: Optional[ValidationConfig] = None):
        self.sensor = sensor
        self.config = config or ValidationConfig()
        self.state = SensorValidationState()

    def evaluate(self, sample: RawEnvironmentalSample) -> List[SensorTelemetryEvent]:
        self.state.last_attempt_at = sample.captured_at
        events: List[SensorTelemetryEvent] = []

        if self.state.pending_suspect and self._pending_expired(sample.captured_at):
            events.append(self._reject_pending("suspect-expired", "Suspect reading was not confirmed before the confirmation period expired."))

        structural = self._parse_structural(sample)
        if isinstance(structural, SensorTelemetryEvent):
            events.append(structural)
            self._mark_rejected(structural)
            return events
        temperature_c, humidity_pct = structural

        hard_problem = self._hard_bound_problem(temperature_c, humidity_pct)
        if hard_problem:
            code, message = hard_problem
            event = self._event(sample.captured_at, CLASSIFICATION_REJECTED, None, None, code, message)
            events.append(event)
            self._mark_rejected(event)
            return events

        if self.state.pending_suspect:
            pending = self.state.pending_suspect.event
            if self._close_to_pending(temperature_c, humidity_pct, pending):
                event = self._accepted(sample.captured_at, temperature_c, humidity_pct)
                events.append(event)
                return events
            if self._close_to_baseline(temperature_c, humidity_pct):
                events.append(self._reject_pending("isolated-spike", "Following sample returned near the previous accepted baseline."))
                # Continue evaluating this sample normally with the suspect cleared.

        suspect_problem = self._suspect_problem(temperature_c, humidity_pct)
        if suspect_problem:
            code, message = suspect_problem
            event = self._event(sample.captured_at, CLASSIFICATION_SUSPECT, temperature_c, humidity_pct, code, message)
            self.state.pending_suspect = PendingSuspect(event)
            self.state.latest_classification = CLASSIFICATION_SUSPECT
            self.state.latest_diagnostic_code = code
            events.append(event)
            return events

        events.append(self._accepted(sample.captured_at, temperature_c, humidity_pct))
        return events

    def stale_event_if_due(self, now: datetime) -> Optional[SensorTelemetryEvent]:
        reference = self.state.last_accepted_at or self.state.last_attempt_at
        if reference is None:
            return None
        if self.state.stale_reported:
            return None
        if now - reference < timedelta(seconds=self.config.stale_timeout_seconds):
            return None
        event = self._event(now, CLASSIFICATION_STALE, None, None, "stale", "No accepted environmental reading has arrived within the stale timeout.")
        self.state.latest_classification = CLASSIFICATION_STALE
        self.state.latest_diagnostic_code = "stale"
        self.state.stale_reported = True
        return event

    def mark_driver_failure(self, attempted_at: Optional[datetime] = None) -> None:
        self.state.consecutive_driver_failures += 1
        self.state.last_attempt_at = attempted_at
        self.state.latest_classification = "failed"
        self.state.latest_diagnostic_code = "driver-read-failed"

    def mark_driver_unavailable(self, attempted_at: Optional[datetime] = None) -> None:
        self.state.consecutive_driver_failures += 1
        self.state.last_attempt_at = attempted_at
        self.state.latest_classification = "driver-unavailable"
        self.state.latest_diagnostic_code = "driver-unavailable"

    def _parse_structural(self, sample: RawEnvironmentalSample) -> Tuple[float, float] | SensorTelemetryEvent:
        if sample.temperature_c is None or sample.humidity_pct is None:
            return self._event(sample.captured_at, CLASSIFICATION_REJECTED, None, None, "missing-value", "Temperature and humidity are both required.")
        if isinstance(sample.temperature_c, bool) or isinstance(sample.humidity_pct, bool):
            return self._event(sample.captured_at, CLASSIFICATION_REJECTED, None, None, "invalid-number", "Temperature and humidity must be numeric.")
        if not isinstance(sample.temperature_c, (int, float)) or not isinstance(sample.humidity_pct, (int, float)):
            return self._event(sample.captured_at, CLASSIFICATION_REJECTED, None, None, "invalid-number", "Temperature and humidity must be numeric.")
        temperature_c = float(sample.temperature_c)
        humidity_pct = float(sample.humidity_pct)
        if not math.isfinite(temperature_c) or not math.isfinite(humidity_pct):
            return self._event(sample.captured_at, CLASSIFICATION_REJECTED, None, None, "invalid-number", "Temperature and humidity must be finite.")
        return temperature_c, humidity_pct

    def _hard_bound_problem(self, temperature_c: float, humidity_pct: float) -> Optional[Tuple[str, str]]:
        if not self.config.hard_temperature_c.contains(temperature_c):
            return "temperature-hard-bound", "Temperature is outside sensor hard physical bounds."
        if not self.config.hard_humidity_pct.contains(humidity_pct):
            return "humidity-hard-bound", "Humidity is outside sensor hard physical bounds."
        return None

    def _suspect_problem(self, temperature_c: float, humidity_pct: float) -> Optional[Tuple[str, str]]:
        if not self.config.plausible_temperature_c.contains(temperature_c):
            return "temperature-plausible-bound", "Temperature is outside configured plausible greenhouse bounds."
        if not self.config.plausible_humidity_pct.contains(humidity_pct):
            return "humidity-plausible-bound", "Humidity is outside configured plausible greenhouse bounds."
        if self.state.last_accepted_temperature_c is not None and abs(temperature_c - self.state.last_accepted_temperature_c) > self.config.sudden_temperature_delta_c:
            return "temperature-sudden-change", "Temperature changed faster than the configured sudden-change threshold."
        if self.state.last_accepted_humidity_pct is not None and abs(humidity_pct - self.state.last_accepted_humidity_pct) > self.config.sudden_humidity_delta_pct:
            return "humidity-sudden-change", "Humidity changed faster than the configured sudden-change threshold."
        return None

    def _accepted(self, captured_at: datetime, temperature_c: float, humidity_pct: float) -> SensorTelemetryEvent:
        event = self._event(captured_at, CLASSIFICATION_ACCEPTED, temperature_c, humidity_pct, None, None)
        self.state.last_accepted_at = captured_at
        self.state.last_accepted_temperature_c = temperature_c
        self.state.last_accepted_humidity_pct = humidity_pct
        self.state.consecutive_driver_failures = 0
        self.state.consecutive_validation_rejects = 0
        self.state.pending_suspect = None
        self.state.latest_classification = CLASSIFICATION_ACCEPTED
        self.state.latest_diagnostic_code = None
        self.state.stale_reported = False
        return event

    def _reject_pending(self, code: str, message: str) -> SensorTelemetryEvent:
        pending = self.state.pending_suspect
        assert pending is not None
        self.state.pending_suspect = None
        event = self._event(
            pending.event.captured_at,
            CLASSIFICATION_REJECTED,
            pending.event.temperature_c,
            pending.event.humidity_pct,
            code,
            message,
            seed="pending",
        )
        self._mark_rejected(event)
        return event

    def _mark_rejected(self, event: SensorTelemetryEvent) -> None:
        self.state.consecutive_validation_rejects += 1
        self.state.latest_classification = CLASSIFICATION_REJECTED
        self.state.latest_diagnostic_code = event.diagnostic_code

    def _pending_expired(self, now: datetime) -> bool:
        pending = self.state.pending_suspect
        return bool(pending and now - pending.event.captured_at > timedelta(seconds=self.config.confirmation_period_seconds))

    def _close_to_pending(self, temperature_c: float, humidity_pct: float, pending: SensorTelemetryEvent) -> bool:
        return (
            pending.temperature_c is not None
            and pending.humidity_pct is not None
            and abs(temperature_c - pending.temperature_c) <= self.config.confirmation_temperature_delta_c
            and abs(humidity_pct - pending.humidity_pct) <= self.config.confirmation_humidity_delta_pct
        )

    def _close_to_baseline(self, temperature_c: float, humidity_pct: float) -> bool:
        return (
            self.state.last_accepted_temperature_c is not None
            and self.state.last_accepted_humidity_pct is not None
            and abs(temperature_c - self.state.last_accepted_temperature_c) <= self.config.confirmation_temperature_delta_c
            and abs(humidity_pct - self.state.last_accepted_humidity_pct) <= self.config.confirmation_humidity_delta_pct
        )

    def _event(
        self,
        captured_at: datetime,
        classification: str,
        temperature_c: Optional[float],
        humidity_pct: Optional[float],
        code: Optional[str],
        message: Optional[str],
        seed: str = "",
    ) -> SensorTelemetryEvent:
        return SensorTelemetryEvent.build(
            sensor=self.sensor,
            captured_at=captured_at,
            classification=classification,
            temperature_c=temperature_c,
            humidity_pct=humidity_pct,
            diagnostic_code=code,
            diagnostic_message=message,
            seed=seed,
        )
