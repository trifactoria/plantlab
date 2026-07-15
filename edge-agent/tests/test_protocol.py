import pytest

from plantlab_edge_agent.protocol import AgentProtocolClient, PROTOCOL_VERSION, ProtocolError, Job, PowerCommand


def test_heartbeat_reports_runtime_and_protocol_version(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    client.heartbeat(
        "greenhouse-zero",
        "greenhouse-node",
        "Raspberry Pi OS Lite",
        "armv6l",
        ["camera"],
        environment={"configuredSensorCount": 1, "enabledSensorCount": 1},
    )

    [sent] = fake_coordinator["state"].heartbeats
    assert sent["runtime"] == "python-edge"
    assert sent["protocolVersion"] == PROTOCOL_VERSION
    assert sent["capabilities"] == ["camera"]
    assert sent["hostname"] == "greenhouse-zero"
    assert sent["environment"] == {"configuredSensorCount": 1, "enabledSensorCount": 1}


def test_unauthenticated_request_raises_protocol_error(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_wrongtoken")
    with pytest.raises(ProtocolError) as excinfo:
        client.heartbeat("h", "camera-node", "os", "arch", [])
    assert excinfo.value.status == 401


def test_credential_check_never_needs_a_body(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    result = client.credential_check()
    assert result["ok"] is True


def test_camera_inventory_round_trip(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    result = client.post_camera_inventory([{"stableId": "s1", "devicePath": "/dev/video0", "available": True, "formats": []}])
    assert result["cameras"] == 1
    assert fake_coordinator["state"].camera_reports == [[{"stableId": "s1", "devicePath": "/dev/video0", "available": True, "formats": []}]]


def test_environment_telemetry_round_trip(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    event = {
        "eventId": "env-1",
        "sensor": {"key": "ambient", "name": "Ambient", "type": "dht22", "gpio": 4, "placement": "Top shelf", "enabled": True},
        "capturedAt": "2026-07-13T15:30:00Z",
        "classification": "accepted",
        "temperatureC": 24.1,
        "humidityPct": 61.5,
        "diagnosticCode": None,
        "diagnosticMessage": None,
    }

    result = client.post_environment("greenhouse-zero", [event])

    assert result["acceptedEventIds"] == ["env-1"]
    assert fake_coordinator["state"].environment_batches == [{"nodeName": "greenhouse-zero", "events": [event]}]


def test_power_state_round_trip(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    outlet = {
        "key": "fans",
        "name": "Fans",
        "provider": "kasa",
        "providerAlias": "greenhouse-fans",
        "enabled": True,
        "safetyClass": "switch",
        "actualState": False,
        "stateObservedAt": "2026-07-13T15:30:00Z",
        "available": True,
        "lastErrorCode": None,
        "lastErrorMessage": None,
    }

    result = client.post_power_state("greenhouse-zero", [outlet])

    assert result["acceptedOutlets"] == ["fans"]
    assert fake_coordinator["state"].power_states == [{"nodeName": "greenhouse-zero", "outlets": [outlet]}]


def test_power_command_protocol_flow(fake_coordinator):
    fake_coordinator["state"].next_power_command_queue.append(
        {"id": "power-1", "outletKey": "fans", "action": "on", "durationSeconds": None, "expiresAt": "2026-07-13T15:35:00Z"}
    )
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")

    command = client.next_power_command()
    assert isinstance(command, PowerCommand)
    assert command.outlet_key == "fans"
    client.claim_power_command(command.id)
    client.complete_power_command(command.id, True, "2026-07-13T15:30:01Z")
    client.fail_power_command("power-2", "power-transport-error", "safe message", None, "2026-07-13T15:30:02Z")

    state = fake_coordinator["state"]
    assert state.power_claimed == ["power-1"]
    assert state.power_completed == [{"commandId": "power-1", "actualState": True, "stateObservedAt": "2026-07-13T15:30:01Z"}]
    assert state.power_failed == [{"commandId": "power-2", "errorCode": "power-transport-error", "errorMessage": "safe message", "actualState": None, "stateObservedAt": "2026-07-13T15:30:02Z"}]


def test_next_job_returns_none_when_queue_is_empty(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    assert client.next_job() is None


def test_next_job_parses_a_queued_job(fake_coordinator):
    fake_coordinator["state"].next_job_queue.append(
        {
            "id": "job-1",
            "captureSourceId": "source-1",
            "assignmentId": "assign-1",
            "camera": {"devicePath": "/dev/video0", "stableId": "s1", "name": "Cam"},
            "settings": {"width": 1280, "height": 720, "inputFormat": "mjpeg"},
        }
    )
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    job = client.next_job()
    assert isinstance(job, Job)
    assert job.id == "job-1"
    assert job.width == 1280
    assert job.device_path == "/dev/video0"
    assert job.frame_rate is None
    assert job.warmup_frames == 10
    assert job.capture_attempts == 2
    assert job.fallback is None


def test_claim_complete_and_fail_job_flow(fake_coordinator):
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    client.claim_job("job-2", "capture-2")
    client.complete_job("job-2", "capture-2")
    client.fail_job("job-3", "camera busy")

    state = fake_coordinator["state"]
    assert state.claimed["job-2"] == "capture-2"
    assert state.completed == [{"jobId": "job-2", "captureId": "capture-2"}]
    assert state.failed == [{"jobId": "job-3", "error": "camera busy"}]


def test_upload_capture_refuses_files_over_the_size_cap(tmp_path, fake_coordinator):
    big_file = tmp_path / "big.jpg"
    big_file.write_bytes(b"\xff" * 2000)
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    with pytest.raises(ProtocolError, match="upload cap"):
        client.upload_capture(str(big_file), {"captureId": "c1"}, max_bytes=1000)
    assert fake_coordinator["state"].ingested == []  # refused before any network call


def test_upload_capture_succeeds_for_a_bounded_frame(tmp_path, fake_coordinator):
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"\xff\xd8\xff" * 10)
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    result = client.upload_capture(str(frame), {"captureId": "c1", "capturedAt": "2026-01-01T00:00:00Z"}, max_bytes=8 * 1024 * 1024)
    assert result["status"] == "created"
    assert len(fake_coordinator["state"].ingested) == 1
