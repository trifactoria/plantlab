"""Shared pytest fixtures - isolated config/credential paths (never the
real ~/.config/plantlab) and a small fake coordinator HTTP server
implementing the same endpoints described in docs/AGENT_PROTOCOL.md, so
protocol/agent-loop tests exercise real HTTP + real JSON parsing without
needing the actual Next.js app running (Part 15: "no access to real
project data").
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from plantlab_edge_agent import config  # noqa: E402


@pytest.fixture()
def isolated_config(tmp_path, monkeypatch):
    """Points config.py's module-level paths at a throwaway directory for
    the duration of one test - never the real $HOME/.config/plantlab."""
    config_dir = tmp_path / "config" / "plantlab"
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "CONFIG_PATH", config_dir / "edge-agent.json")
    monkeypatch.setattr(config, "CREDENTIAL_PATH", config_dir / "agent.env")
    monkeypatch.setattr(config, "GREENHOUSE_SECRET_PATH", config_dir / "greenhouse.env")
    return config_dir


class _FakeCoordinatorState:
    def __init__(self):
        self.valid_tokens = {"pln_validtoken"}
        self.heartbeats = []
        self.camera_reports = []
        self.jobs = {}
        self.claimed = {}
        self.completed = []
        self.failed = []
        self.ingested = []
        self.environment_batches = []
        self.power_states = []
        self.next_power_command_queue = []
        self.power_claimed = []
        self.power_completed = []
        self.power_failed = []
        self.power_refresh_requested_at = None
        self.next_job_queue = []
        self.camera_refresh_requested_at = None
        self.next_sensor_test_queue = []
        self.sensor_test_claimed = []
        self.sensor_test_started = []
        self.sensor_test_reported = []
        self.sensor_test_failed = []
        self.node_environment_response = {"sensors": []}

    def authorized(self, headers) -> bool:
        auth = headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return auth[len("Bearer ") :] in self.valid_tokens


class _Handler(BaseHTTPRequestHandler):
    state: _FakeCoordinatorState

    def log_message(self, *args):  # silence default stderr logging
        pass

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else {}

    def do_POST(self):  # noqa: N802 (matches BaseHTTPRequestHandler's naming)
        if not self.state.authorized(self.headers) and self.path != "/api/agent-ingest":
            self._send_json(401, {"error": "Unauthorized"})
            return

        if self.path == "/api/agents/heartbeat":
            body = self._read_json_body()
            self.state.heartbeats.append(body)
            self._send_json(200, {"status": "ok", "node": {"name": body.get("hostname"), "role": body.get("role")}})
            return

        if self.path == "/api/agents/credential-check":
            self._send_json(200, {"ok": True, "node": {"name": "test-node", "role": "greenhouse-node"}})
            return

        if self.path == "/api/agents/cameras":
            body = self._read_json_body()
            self.state.camera_reports.append(body.get("cameras", []))
            self.state.camera_refresh_requested_at = None
            self._send_json(200, {"status": "ok", "cameras": len(body.get("cameras", [])), "assignments": []})
            return

        if self.path == "/api/agents/environment":
            body = self._read_json_body()
            events = body.get("events", [])
            self.state.environment_batches.append(body)
            self._send_json(
                200,
                {
                    "status": "ok",
                    "acceptedEventIds": [event.get("eventId") for event in events if isinstance(event, dict) and event.get("eventId")],
                    "duplicateEventIds": [],
                    "storedReadings": len([event for event in events if isinstance(event, dict) and event.get("classification") == "accepted"]),
                    "storedDiagnostics": len([event for event in events if isinstance(event, dict) and event.get("classification") != "accepted"]),
                },
            )
            return

        if self.path == "/api/agents/power/state":
            body = self._read_json_body()
            self.state.power_states.append(body)
            self._send_json(200, {"status": "ok", "acceptedOutlets": [outlet.get("key") for outlet in body.get("outlets", []) if isinstance(outlet, dict)], "count": len(body.get("outlets", []))})
            return

        if self.path.startswith("/api/agents/power/commands/") and self.path.endswith("/claim"):
            command_id = self.path.split("/")[5]
            self.state.power_claimed.append(command_id)
            self._send_json(200, {"status": "claimed", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/power/commands/") and self.path.endswith("/complete"):
            command_id = self.path.split("/")[5]
            body = self._read_json_body()
            self.state.power_completed.append({"commandId": command_id, **body})
            self._send_json(200, {"status": "succeeded", "commandId": command_id, "actualState": body.get("actualState")})
            return

        if self.path.startswith("/api/agents/power/commands/") and self.path.endswith("/fail"):
            command_id = self.path.split("/")[5]
            body = self._read_json_body()
            self.state.power_failed.append({"commandId": command_id, **body})
            self._send_json(200, {"status": "failed", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/sensor-tests/") and self.path.endswith("/claim"):
            command_id = self.path.split("/")[4]
            self.state.sensor_test_claimed.append(command_id)
            self._send_json(200, {"status": "claimed", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/sensor-tests/") and self.path.endswith("/start"):
            command_id = self.path.split("/")[4]
            self.state.sensor_test_started.append(command_id)
            self._send_json(200, {"status": "running", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/sensor-tests/") and self.path.endswith("/report"):
            command_id = self.path.split("/")[4]
            body = self._read_json_body()
            self.state.sensor_test_reported.append({"commandId": command_id, **body})
            self._send_json(200, {"status": "succeeded" if body.get("finalPass") else "failed", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/sensor-tests/") and self.path.endswith("/fail"):
            command_id = self.path.split("/")[4]
            body = self._read_json_body()
            self.state.sensor_test_failed.append({"commandId": command_id, **body})
            self._send_json(200, {"status": "failed", "commandId": command_id})
            return

        if self.path.startswith("/api/agents/jobs/") and self.path.endswith("/claim"):
            job_id = self.path.split("/")[4]
            body = self._read_json_body()
            self.state.claimed[job_id] = body.get("captureId")
            self._send_json(200, {"status": "claimed", "captureId": body.get("captureId")})
            return

        if self.path.startswith("/api/agents/jobs/") and self.path.endswith("/complete"):
            job_id = self.path.split("/")[4]
            body = self._read_json_body()
            self.state.completed.append({"jobId": job_id, "captureId": body.get("captureId")})
            self._send_json(200, {"status": "completed", "sourceCaptureId": "sc1", "captureId": body.get("captureId")})
            return

        if self.path.startswith("/api/agents/jobs/") and self.path.endswith("/fail"):
            job_id = self.path.split("/")[4]
            body = self._read_json_body()
            self.state.failed.append({"jobId": job_id, "error": body.get("error")})
            self._send_json(200, {"status": "failed"})
            return

        if self.path == "/api/agent-ingest":
            if not self.state.authorized(self.headers):
                self._send_json(401, {"error": "Unauthorized"})
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            self.state.ingested.append(len(raw))
            self._send_json(201, {"status": "created", "sourceCaptureId": "sc1", "captureId": "ignored", "storageKey": "k"})
            return

        self._send_json(404, {"error": "not found"})

    def do_GET(self):  # noqa: N802
        if self.path == "/api/node-info":
            self._send_json(200, {"name": "test-coordinator", "role": "coordinator", "health": "ok"})
            return
        if not self.state.authorized(self.headers):
            self._send_json(401, {"error": "Unauthorized"})
            return
        if self.path == "/api/agents/jobs/next":
            job = self.state.next_job_queue.pop(0) if self.state.next_job_queue else None
            self._send_json(200, {"job": job})
            return
        if self.path == "/api/agents/power/commands/next":
            command = self.state.next_power_command_queue.pop(0) if self.state.next_power_command_queue else None
            self._send_json(200, {"command": command})
            return
        if self.path == "/api/agents/power/refresh":
            self._send_json(
                200,
                {
                    "requested": self.state.power_refresh_requested_at is not None,
                    "requestedAt": self.state.power_refresh_requested_at,
                },
            )
            return
        if self.path == "/api/agents/sensor-tests/next":
            command = self.state.next_sensor_test_queue.pop(0) if self.state.next_sensor_test_queue else None
            self._send_json(200, {"command": command})
            return
        if self.path.startswith("/api/nodes/") and self.path.endswith("/environment"):
            self._send_json(200, self.state.node_environment_response)
            return
        if self.path == "/api/agents/cameras/refresh":
            self._send_json(
                200,
                {
                    "requested": self.state.camera_refresh_requested_at is not None,
                    "requestedAt": self.state.camera_refresh_requested_at,
                },
            )
            return
        self._send_json(404, {"error": "not found"})


@pytest.fixture()
def fake_coordinator():
    state = _FakeCoordinatorState()

    class Handler(_Handler):
        pass

    Handler.state = state
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        yield {"url": f"http://127.0.0.1:{port}", "state": state}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
