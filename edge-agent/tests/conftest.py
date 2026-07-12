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
        self.next_job_queue = []

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
            self._send_json(200, {"status": "ok", "cameras": len(body.get("cameras", [])), "assignments": []})
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
