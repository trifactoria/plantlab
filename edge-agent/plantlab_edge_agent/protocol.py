"""HTTP client for the PlantLab agent protocol - see docs/AGENT_PROTOCOL.md.

Stdlib only (urllib.request) - no `requests` dependency, so the edge agent
needs nothing beyond a stock Python 3 interpreter (Raspberry Pi OS Lite
ships one). Implements the exact same wire contract the full TypeScript
agent (scripts/agent-service.ts) speaks - there is only one protocol.
"""

from __future__ import annotations

import json
import os
import platform
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

PROTOCOL_VERSION = "1"
AGENT_RUNTIME = "python-edge"
try:
    from importlib.metadata import version as _pkg_version

    AGENT_VERSION = _pkg_version("plantlab-edge-agent")
except Exception:  # pragma: no cover - falls back cleanly when not installed as a package
    AGENT_VERSION = "0.1.0"


class ProtocolError(Exception):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def _open(req: urlrequest.Request, timeout: float):
    try:
        return urlrequest.urlopen(req, timeout=timeout)
    except urlerror.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"error": raw.decode("utf-8", "replace")}
        raise ProtocolError(f"{req.full_url} returned {exc.code}: {parsed}", status=exc.code) from None
    except urlerror.URLError as exc:
        raise ProtocolError(f"{req.full_url} unreachable: {exc.reason}") from None


def request_json(url: str, token: str, method: str = "GET", body: Optional[dict] = None, timeout: float = 10) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urlrequest.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    with _open(req, timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def post_multipart(
    url: str,
    token: str,
    fields: Dict[str, str],
    file_field_name: str,
    file_path: str,
    file_content_type: str = "image/jpeg",
    max_bytes: int = 8 * 1024 * 1024,
    timeout: float = 30,
) -> dict:
    """Builds a multipart/form-data body by hand (no `requests`). Refuses
    files over max_bytes before reading anything into memory - see Part 14
    "avoid loading complete images into memory when possible" / "cap
    upload... size". A single bounded JPEG frame (a few hundred KB at the
    edge agent's conservative default resolutions) is read fully into
    memory once, which is a deliberate, documented trade-off against the
    much larger complexity of a true streaming multipart encoder for a
    "smallest viable" implementation - see edge-agent/README.md
    "Known limitations".
    """
    size = os.path.getsize(file_path)
    if size > max_bytes:
        raise ProtocolError(f"{file_path} is {size} bytes, over the {max_bytes}-byte upload cap - refusing to upload.")

    boundary = "----plantlabedge" + uuid.uuid4().hex
    parts: List[bytes] = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode("utf-8"))
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        parts.append(value.encode("utf-8"))
        parts.append(b"\r\n")
    parts.append(f"--{boundary}\r\n".encode("utf-8"))
    filename = os.path.basename(file_path)
    parts.append(f'Content-Disposition: form-data; name="{file_field_name}"; filename="{filename}"\r\n'.encode("utf-8"))
    parts.append(f"Content-Type: {file_content_type}\r\n\r\n".encode("utf-8"))
    with open(file_path, "rb") as f:
        parts.append(f.read())
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    data = b"".join(parts)

    req = urlrequest.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with _open(req, timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


@dataclass
class Job:
    id: str
    capture_source_id: str
    assignment_id: str
    device_path: str
    stable_id: str
    camera_name: Optional[str]
    width: int
    height: int
    input_format: str

    @staticmethod
    def from_wire(raw: dict) -> "Job":
        camera = raw["camera"]
        settings = raw["settings"]
        return Job(
            id=raw["id"],
            capture_source_id=raw["captureSourceId"],
            assignment_id=raw["assignmentId"],
            device_path=camera["devicePath"],
            stable_id=camera["stableId"],
            camera_name=camera.get("name"),
            width=settings["width"],
            height=settings["height"],
            input_format=settings.get("inputFormat", "mjpeg"),
        )


@dataclass
class PowerCommand:
    id: str
    outlet_key: str
    action: str
    duration_seconds: Optional[int]
    expires_at: str

    @staticmethod
    def from_wire(raw: dict) -> "PowerCommand":
        return PowerCommand(
            id=raw["id"],
            outlet_key=raw["outletKey"],
            action=raw["action"],
            duration_seconds=raw.get("durationSeconds"),
            expires_at=raw["expiresAt"],
        )


@dataclass
class SensorTestCommand:
    id: str
    sensor_key: str
    attempts_requested: int
    interval_seconds: float
    expires_at: str

    @staticmethod
    def from_wire(raw: dict) -> "SensorTestCommand":
        return SensorTestCommand(
            id=raw["id"],
            sensor_key=raw["sensorKey"],
            attempts_requested=raw["attemptsRequested"],
            interval_seconds=raw["intervalSeconds"],
            expires_at=raw["expiresAt"],
        )


class AgentProtocolClient:
    def __init__(self, coordinator_url: str, token: str):
        self.coordinator_url = coordinator_url.rstrip("/")
        self.token = token

    def _url(self, path: str) -> str:
        return f"{self.coordinator_url}{path}"

    def heartbeat(self, hostname: str, role: str, operating_system: str, architecture: str, capabilities: List[str], environment: Optional[dict] = None) -> dict:
        body = {
            "hostname": hostname,
            "role": role,
            "operatingSystem": operating_system,
            "architecture": architecture,
            "softwareVersion": AGENT_VERSION,
            "runtime": AGENT_RUNTIME,
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": capabilities,
        }
        if environment is not None:
            body["environment"] = environment
        return request_json(
            self._url("/api/agents/heartbeat"),
            self.token,
            method="POST",
            body=body,
        )

    def credential_check(self) -> dict:
        return request_json(self._url("/api/agents/credential-check"), self.token, method="POST", body={})

    def post_camera_inventory(self, cameras: List[dict]) -> dict:
        return request_json(self._url("/api/agents/cameras"), self.token, method="POST", body={"cameras": cameras})

    def post_environment(self, node_name: str, events: List[dict]) -> dict:
        return request_json(self._url("/api/agents/environment"), self.token, method="POST", body={"nodeName": node_name, "events": events}, timeout=20)

    def desired_sensor_config(self) -> dict:
        return request_json(self._url("/api/agents/sensors/config"), self.token, method="GET", timeout=10)

    def report_sensor_config(self, payload: Dict[str, Any]) -> dict:
        return request_json(self._url("/api/agents/sensors/config/report"), self.token, method="POST", body=payload, timeout=15)

    def post_power_state(self, node_name: str, outlets: List[dict]) -> dict:
        return request_json(self._url("/api/agents/power/state"), self.token, method="POST", body={"nodeName": node_name, "outlets": outlets}, timeout=20)

    def next_power_command(self) -> Optional[PowerCommand]:
        result = request_json(self._url("/api/agents/power/commands/next"), self.token, method="GET")
        command = result.get("command")
        return PowerCommand.from_wire(command) if command else None

    def claim_power_command(self, command_id: str) -> None:
        request_json(self._url(f"/api/agents/power/commands/{command_id}/claim"), self.token, method="POST", body={})

    def complete_power_command(self, command_id: str, actual_state: Optional[bool], state_observed_at: str) -> None:
        request_json(
            self._url(f"/api/agents/power/commands/{command_id}/complete"),
            self.token,
            method="POST",
            body={"actualState": actual_state, "stateObservedAt": state_observed_at},
        )

    def fail_power_command(self, command_id: str, error_code: str, error_message: str, actual_state: Optional[bool] = None, state_observed_at: Optional[str] = None) -> None:
        body: Dict[str, Any] = {
            "errorCode": error_code,
            "errorMessage": error_message,
            "actualState": actual_state,
        }
        if state_observed_at:
            body["stateObservedAt"] = state_observed_at
        request_json(self._url(f"/api/agents/power/commands/{command_id}/fail"), self.token, method="POST", body=body)

    def camera_inventory_refresh_request(self) -> dict:
        return request_json(self._url("/api/agents/cameras/refresh"), self.token, method="GET")

    def power_state_refresh_request(self) -> dict:
        return request_json(self._url("/api/agents/power/refresh"), self.token, method="GET")

    def next_sensor_test(self) -> Optional[SensorTestCommand]:
        result = request_json(self._url("/api/agents/sensor-tests/next"), self.token, method="GET")
        command = result.get("command")
        return SensorTestCommand.from_wire(command) if command else None

    def claim_sensor_test(self, command_id: str) -> None:
        request_json(self._url(f"/api/agents/sensor-tests/{command_id}/claim"), self.token, method="POST", body={})

    def start_sensor_test(self, command_id: str) -> None:
        request_json(self._url(f"/api/agents/sensor-tests/{command_id}/start"), self.token, method="POST", body={})

    def report_sensor_test(self, command_id: str, payload: Dict[str, Any]) -> None:
        request_json(self._url(f"/api/agents/sensor-tests/{command_id}/report"), self.token, method="POST", body=payload, timeout=15)

    def fail_sensor_test(self, command_id: str, error_code: str, error_message: str) -> None:
        request_json(self._url(f"/api/agents/sensor-tests/{command_id}/fail"), self.token, method="POST", body={"errorCode": error_code, "errorMessage": error_message})

    def next_job(self) -> Optional[Job]:
        result = request_json(self._url("/api/agents/jobs/next"), self.token, method="GET")
        job = result.get("job")
        return Job.from_wire(job) if job else None

    def claim_job(self, job_id: str, capture_id: str) -> None:
        request_json(self._url(f"/api/agents/jobs/{job_id}/claim"), self.token, method="POST", body={"captureId": capture_id})

    def complete_job(self, job_id: str, capture_id: str) -> None:
        request_json(self._url(f"/api/agents/jobs/{job_id}/complete"), self.token, method="POST", body={"captureId": capture_id})

    def fail_job(self, job_id: str, error_message: str) -> None:
        request_json(self._url(f"/api/agents/jobs/{job_id}/fail"), self.token, method="POST", body={"error": error_message})

    def upload_capture(self, file_path: str, metadata: Dict[str, Any], max_bytes: int) -> dict:
        return post_multipart(
            self._url("/api/agent-ingest"),
            self.token,
            fields={"metadata": json.dumps(metadata)},
            file_field_name="image",
            file_path=file_path,
            max_bytes=max_bytes,
        )


def platform_info() -> Dict[str, str]:
    return {
        "hostname": platform.node(),
        "operating_system": f"{platform.system()} {platform.release()}",
        "architecture": platform.machine(),
    }
