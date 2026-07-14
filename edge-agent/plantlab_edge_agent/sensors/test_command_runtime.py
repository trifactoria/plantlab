"""Polls, claims, executes, and reports remote sensor-test commands.

Mirrors power/runtime.py's poll_and_execute_power_command almost exactly -
same poll/claim/execute/report shape, same unexpected-exception safety net,
same bounded retry on the final result upload. The one addition is the
explicit "running" transition (start_sensor_test) between claim and
execute, since a bounded multi-attempt test takes long enough (up to tens
of seconds) that the UI benefits from a distinct in-progress state.
"""

from __future__ import annotations

import logging
import time

from .. import config
from ..protocol import AgentProtocolClient, ProtocolError, SensorTestCommand
from .dht22 import DHT22PigpioDriver
from .test_runner import SensorTestResult, run_bounded_sensor_test

logger = logging.getLogger("plantlab_edge_agent")

RESULT_REPORT_RETRY_ATTEMPTS = 3
RESULT_REPORT_RETRY_BACKOFF_SECONDS = 0.5


def poll_and_execute_sensor_test(cfg: config.EdgeAgentConfig, client: AgentProtocolClient) -> None:
    poll_started = time.monotonic()
    logger.info("Sensor test poll started")
    try:
        command = client.next_sensor_test()
    except ProtocolError as exc:
        logger.warning("Sensor test poll failed: %s", exc)
        return
    if command is None:
        return
    logger.info(
        "Sensor test received: command=%s sensor=%s attempts=%d elapsed=%.2fs",
        command.id,
        command.sensor_key,
        command.attempts_requested,
        time.monotonic() - poll_started,
    )

    claim_started = time.monotonic()
    try:
        client.claim_sensor_test(command.id)
    except ProtocolError as exc:
        logger.warning("Could not claim sensor test %s: %s", command.id, exc)
        return
    logger.info("Sensor test claim succeeded: command=%s elapsed=%.2fs", command.id, time.monotonic() - claim_started)

    sensor = _find_sensor(cfg, command.sensor_key)
    if sensor is None:
        _report_sensor_test_failure(client, command.id, "sensor-not-configured", f"Sensor {command.sensor_key} is not present in this node's configuration.")
        return
    if sensor.type != "dht22":
        _report_sensor_test_failure(client, command.id, "sensor-unsupported-type", f"Sensor {command.sensor_key} has unsupported type {sensor.type} for remote testing.")
        return

    try:
        client.start_sensor_test(command.id)
    except ProtocolError as exc:
        # Not marked running - do not execute. The coordinator's stale-claim
        # recovery will reopen it for a future poll rather than leaving it stuck.
        logger.warning("Could not mark sensor test %s running: %s", command.id, exc)
        return
    logger.info("Sensor test running: command=%s sensor=%s", command.id, command.sensor_key)

    exec_started = time.monotonic()
    try:
        driver = DHT22PigpioDriver(sensor)
        result = run_bounded_sensor_test(driver, sensor, command.attempts_requested, command.interval_seconds)
    except Exception as exc:  # noqa: BLE001 - a claimed/running test must always be resolved, never left to strand the whole agent loop
        logger.error("Sensor test execution raised an unexpected error: command=%s error=%s", command.id, exc)
        _report_sensor_test_failure(client, command.id, "sensor-test-unexpected-error", "Unexpected error executing sensor test.")
        return
    logger.info(
        "Sensor test execution finished: command=%s pass=%s accepted=%d failed=%d elapsed=%.2fs",
        command.id,
        result.final_pass,
        result.accepted_count,
        result.failed_count,
        time.monotonic() - exec_started,
    )

    _report_sensor_test_result(client, command.id, result)


def _report_sensor_test_result(client: AgentProtocolClient, command_id: str, result: SensorTestResult) -> None:
    payload = {
        "attemptsCompleted": len(result.attempts),
        "acceptedCount": result.accepted_count,
        "failedCount": result.failed_count,
        "finalPass": result.final_pass,
        "effectiveDriver": "pigpio",
        "configuredGpio": result.configured_gpio,
        "attempts": [
            {
                "attempt": outcome.attempt,
                "classification": outcome.classification,
                "code": outcome.code,
                "message": outcome.message,
                "temperatureC": outcome.temperature_c,
                "humidityPct": outcome.humidity_pct,
            }
            for outcome in result.attempts
        ],
    }
    last_error: ProtocolError | None = None
    for attempt in range(1, RESULT_REPORT_RETRY_ATTEMPTS + 1):
        try:
            client.report_sensor_test(command_id, payload)
            if attempt > 1:
                logger.info("Sensor test result upload succeeded after retry: command=%s attempt=%d", command_id, attempt)
            else:
                logger.info("Sensor test result upload succeeded: command=%s", command_id)
            return
        except ProtocolError as exc:
            last_error = exc
            if attempt < RESULT_REPORT_RETRY_ATTEMPTS:
                logger.warning("Sensor test result upload retry: command=%s attempt=%d error=%s", command_id, attempt, exc)
                time.sleep(RESULT_REPORT_RETRY_BACKOFF_SECONDS * attempt)
    logger.warning(
        "Sensor test result upload failed after %d attempts: command=%s error=%s - relying on coordinator stale-claim recovery",
        RESULT_REPORT_RETRY_ATTEMPTS,
        command_id,
        last_error,
    )


def _report_sensor_test_failure(client: AgentProtocolClient, command_id: str, code: str, message: str) -> None:
    try:
        client.fail_sensor_test(command_id, code, message)
    except ProtocolError as exc:
        logger.warning("Could not report sensor test failure for %s: %s", command_id, exc)


def _find_sensor(cfg: config.EdgeAgentConfig, key: str):
    for sensor in cfg.sensors:
        if sensor.key == key:
            return sensor
    return None
