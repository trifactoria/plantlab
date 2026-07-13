from pathlib import Path

from plantlab_edge_agent.spool import Spool


def _write_frame(path: Path, size: int = 100) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff" * size)


def test_init_creates_all_state_directories(tmp_path):
    spool = Spool(str(tmp_path / "spool-root"))
    spool.init()
    try:
        for state in ("pending", "uploading", "acknowledged", "failed"):
            assert spool.dir(state).is_dir()
        assert (tmp_path / "spool-root" / "state.sqlite").exists()
    finally:
        spool.close()


def test_capture_written_before_any_network_call_survives_restart():
    """Part 9 'capture written locally before upload, survives restart' - simulate a restart by closing and reopening a Spool against the same root, and confirm the pending record + file are both still there."""
    import tempfile

    with tempfile.TemporaryDirectory() as root:
        spool = Spool(root)
        spool.init()
        output_path = spool.pending_path("capture-1")
        _write_frame(Path(output_path))
        spool.record_captured(
            job_id="job-1",
            capture_id="capture-1",
            assignment_id="assign-1",
            capture_source_id="source-1",
            local_file_path=output_path,
            captured_at="2026-01-01T00:00:00Z",
        )
        spool.close()  # simulates a restart / power loss right after capture

        reopened = Spool(root)
        reopened.init()
        try:
            due = reopened.due_uploads()
            assert len(due) == 1
            assert due[0].capture_id == "capture-1"
            assert Path(due[0].local_file_path).exists()
        finally:
            reopened.close()


def test_move_file_for_state_moves_both_file_and_db_row(tmp_path):
    spool = Spool(str(tmp_path))
    spool.init()
    try:
        output_path = spool.pending_path("capture-2")
        _write_frame(Path(output_path))
        spool.record_captured("job-2", "capture-2", "assign-2", "source-2", output_path, "2026-01-01T00:00:00Z")

        [record] = spool.due_uploads()
        moved = spool.move_file_for_state(record, "uploading")
        assert moved.state == "uploading"
        assert Path(moved.local_file_path).exists()
        assert not Path(output_path).exists()
        assert Path(moved.local_file_path).parent == spool.dir("uploading")
    finally:
        spool.close()


def test_mark_failed_schedules_a_retry_with_exponential_backoff(tmp_path):
    spool = Spool(str(tmp_path))
    spool.init()
    try:
        output_path = spool.pending_path("capture-3")
        _write_frame(Path(output_path))
        spool.record_captured("job-3", "capture-3", "assign-3", "source-3", output_path, "2026-01-01T00:00:00Z")
        [record] = spool.due_uploads()
        moved = spool.move_file_for_state(record, "uploading")

        spool.mark_failed(moved.job_id, "network error")

        # Immediately after a failure, the retry window hasn't elapsed yet -
        # due_uploads() must not return it again right away.
        assert spool.due_uploads() == []

        row = spool._db.execute("SELECT attemptCount, nextRetryAt FROM spool_records WHERE jobId = ?", (moved.job_id,)).fetchone()
        assert row[0] == 1
        assert row[1] is not None  # a future retry timestamp was recorded
    finally:
        spool.close()


def test_cleanup_acknowledged_only_deletes_after_acknowledgment_and_retention(tmp_path):
    spool = Spool(str(tmp_path))
    spool.init()
    try:
        output_path = spool.pending_path("capture-4")
        _write_frame(Path(output_path))
        spool.record_captured("job-4", "capture-4", "assign-4", "source-4", output_path, "2020-01-01T00:00:00Z")  # far in the past
        [record] = spool.due_uploads()
        moved = spool.move_file_for_state(record, "uploading")
        moved = spool.move_file_for_state(moved, "acknowledged")
        spool.mark_acknowledged(moved.job_id)

        # A record that's still "pending"/"uploading" (never acknowledged)
        # must never be swept up by cleanup, no matter how old.
        second_output = spool.pending_path("capture-5")
        _write_frame(Path(second_output))
        spool.record_captured("job-5", "capture-5", "assign-5", "source-5", second_output, "2020-01-01T00:00:00Z")

        removed = spool.cleanup_acknowledged(retain_seconds=60)
        assert removed == 1
        assert not Path(moved.local_file_path).exists()

        remaining = spool._db.execute("SELECT jobId, state FROM spool_records").fetchall()
        assert remaining == [("job-5", "pending")]
    finally:
        spool.close()


def test_has_room_for_respects_a_bounded_max_spool_size(tmp_path):
    """Part 14 'cap upload and spool size' - bounded disk usage."""
    spool = Spool(str(tmp_path), max_spool_bytes=1000)
    spool.init()
    try:
        assert spool.has_room_for(500) is True

        output_path = spool.pending_path("capture-6")
        _write_frame(Path(output_path), size=900)
        spool.record_captured("job-6", "capture-6", "assign-6", "source-6", output_path, "2026-01-01T00:00:00Z")

        assert spool.has_room_for(500) is False  # 900 already used, cap is 1000
        assert spool.has_room_for(50) is True
    finally:
        spool.close()


def test_environment_events_survive_restart_and_acknowledge(tmp_path):
    event = {
        "eventId": "env-spool-1",
        "sensor": {"key": "ambient", "name": "Ambient", "type": "dht22", "gpio": 4, "placement": None, "enabled": True},
        "capturedAt": "2026-07-13T15:30:00Z",
        "classification": "accepted",
        "temperatureC": 24.0,
        "humidityPct": 60.0,
        "diagnosticCode": None,
        "diagnosticMessage": None,
    }

    spool = Spool(str(tmp_path))
    spool.init()
    try:
        assert spool.record_environment_events([event]) == 1
    finally:
        spool.close()

    reopened = Spool(str(tmp_path))
    reopened.init()
    try:
        [record] = reopened.due_environment_events()
        assert record.event_id == "env-spool-1"
        assert record.payload()["temperatureC"] == 24.0

        reopened.mark_environment_acknowledged(["env-spool-1"])
        assert reopened.due_environment_events() == []
    finally:
        reopened.close()


def test_environment_retry_backoff_and_cleanup(tmp_path):
    spool = Spool(str(tmp_path))
    spool.init()
    try:
        event = {
            "eventId": "env-spool-2",
            "sensor": {"key": "ambient", "name": "Ambient", "type": "dht22", "gpio": 4, "placement": None, "enabled": True},
            "capturedAt": "2020-01-01T00:00:00Z",
            "classification": "failed",
            "temperatureC": None,
            "humidityPct": None,
            "diagnosticCode": "driver-read-failed",
            "diagnosticMessage": "Sensor driver read failed.",
        }
        spool.record_environment_events([event])

        spool.mark_environment_failed(["env-spool-2"], "offline")
        assert spool.due_environment_events() == []
        row = spool._db.execute("SELECT state, attemptCount, lastError FROM environment_events WHERE eventId = ?", ("env-spool-2",)).fetchone()
        assert row == ("failed", 1, "offline")

        spool.mark_environment_acknowledged(["env-spool-2"])
        assert spool.cleanup_acknowledged_environment(retain_seconds=60) == 1
    finally:
        spool.close()
