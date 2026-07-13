from pathlib import Path
from unittest.mock import patch

from plantlab_edge_agent import agent, camera, config
from plantlab_edge_agent.protocol import AgentProtocolClient
from plantlab_edge_agent.spool import Spool


def _make_config(tmp_path, coordinator_url):
    return config.EdgeAgentConfig(
        role="greenhouse-node",
        node_name="greenhouse-zero",
        coordinator_url=coordinator_url,
        spool_root=str(tmp_path / "spool"),
        capabilities=["camera"],
        max_upload_bytes=8 * 1024 * 1024,
        max_spool_bytes=512 * 1024 * 1024,
    )


def test_run_heartbeat_and_inventory_reports_discovered_cameras(tmp_path, fake_coordinator):
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")

    formats = [{"pixelFormat": "mjpeg", "description": "Motion-JPEG", "resolutions": [{"width": 1280, "height": 720, "frameRates": ["30.000 fps"]}]}]
    fake_camera = camera.CameraInfo(device="/dev/video0", name="Test Cam", stable_id="usb:1:2:3", verified_capture=True, formats=formats)
    with patch.object(camera, "discover_cameras", return_value=[fake_camera]):
        agent.run_heartbeat_and_inventory(cfg, client)

    state = fake_coordinator["state"]
    assert len(state.heartbeats) == 1
    assert state.camera_reports == [
        [
            {
                "stableId": "usb:1:2:3",
                "legacyStableId": None,
                "devicePath": "/dev/video0",
                "name": "Test Cam",
                "vendorId": None,
                "productId": None,
                "serial": None,
                "physicalPath": None,
                "usbPath": None,
                "usbPort": None,
                "alternateDevices": [],
                "available": True,
                "formats": formats,
                "formatsStatus": "unknown",
                "formatsError": None,
            }
        ]
    ]


def test_run_heartbeat_and_inventory_reports_unverified_devices_as_unavailable(tmp_path, fake_coordinator):
    """Part 5/9: a device with no verified real capture (e.g. a Raspberry Pi's
    bcm2835-codec-decode/isp hardware helper nodes) must never be reported as
    available - metadata claiming "Video Capture" support isn't proof, and a
    nontechnical user's dashboard should never count it as a real camera."""
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")

    fake_camera = camera.CameraInfo(device="/dev/video10", name="bcm2835-codec-decode", stable_id="platform:bcm2835-codec-decode", verified_capture=False)
    with patch.object(camera, "discover_cameras", return_value=[fake_camera]):
        agent.run_heartbeat_and_inventory(cfg, client)

    state = fake_coordinator["state"]
    assert state.camera_reports == [
        [
            {
                "stableId": "platform:bcm2835-codec-decode",
                "legacyStableId": None,
                "devicePath": "/dev/video10",
                "name": "bcm2835-codec-decode",
                "vendorId": None,
                "productId": None,
                "serial": None,
                "physicalPath": None,
                "usbPath": None,
                "usbPort": None,
                "alternateDevices": [],
                "available": False,
                "formats": [],
                "formatsStatus": "unknown",
                "formatsError": None,
            }
        ]
    ]


def test_poll_and_run_job_captures_a_frame_to_the_durable_spool_before_uploading(tmp_path, fake_coordinator):
    """Part 7/9: a manual capture job flows through claim -> capture -> durable spool record, all before any upload attempt."""
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    try:
        fake_coordinator["state"].next_job_queue.append(
            {
                "id": "job-1",
                "captureSourceId": "source-1",
                "assignmentId": "assign-1",
                "camera": {"devicePath": "/dev/video0", "stableId": "s1", "name": "Cam"},
                "settings": {"width": 1280, "height": 720, "inputFormat": "mjpeg"},
            }
        )

        def fake_capture(device, output_path, width=None, height=None, input_format=None):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\xff\xd8\xff")

        with patch.object(camera, "capture_frame", side_effect=fake_capture):
            agent.poll_and_run_job(cfg, client, spool)

        due = spool.due_uploads()
        assert len(due) == 1
        assert due[0].job_id == "job-1"
        assert Path(due[0].local_file_path).exists()
        assert fake_coordinator["state"].claimed["job-1"] is not None
    finally:
        spool.close()


def test_poll_and_run_job_reports_failure_when_capture_raises(tmp_path, fake_coordinator):
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    try:
        fake_coordinator["state"].next_job_queue.append(
            {
                "id": "job-2",
                "captureSourceId": "source-1",
                "assignmentId": "assign-1",
                "camera": {"devicePath": "/dev/video0", "stableId": "s1", "name": "Cam"},
                "settings": {"width": 1280, "height": 720, "inputFormat": "mjpeg"},
            }
        )

        with patch.object(camera, "capture_frame", side_effect=RuntimeError("camera busy")):
            agent.poll_and_run_job(cfg, client, spool)

        assert spool.due_uploads() == []  # nothing durable was recorded
        assert fake_coordinator["state"].failed == [{"jobId": "job-2", "error": "camera busy"}]
    finally:
        spool.close()


def test_poll_and_run_job_skips_capture_when_spool_is_at_capacity(tmp_path, fake_coordinator):
    """Part 14 - bounded spool behavior: refuses new work rather than growing unboundedly."""
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    cfg.max_spool_bytes = 10  # already effectively full
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    try:
        fake_coordinator["state"].next_job_queue.append(
            {
                "id": "job-3",
                "captureSourceId": "source-1",
                "assignmentId": "assign-1",
                "camera": {"devicePath": "/dev/video0", "stableId": "s1", "name": "Cam"},
                "settings": {"width": 1280, "height": 720, "inputFormat": "mjpeg"},
            }
        )
        with patch.object(camera, "capture_frame") as mocked_capture:
            agent.poll_and_run_job(cfg, client, spool)
            mocked_capture.assert_not_called()

        # The job was never even claimed, since we bailed before attempting it.
        assert "job-3" not in fake_coordinator["state"].claimed
    finally:
        spool.close()


def test_process_uploads_moves_a_pending_capture_through_to_acknowledged(tmp_path, fake_coordinator):
    """The full durable-retry-free happy path: pending -> uploading -> acknowledged, with complete_job called."""
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    try:
        output_path = spool.pending_path("capture-1")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"\xff\xd8\xff")
        spool.record_captured("job-1", "capture-1", "assign-1", "source-1", output_path, "2026-01-01T00:00:00Z")

        agent.process_uploads(cfg, client, spool)

        assert spool.due_uploads() == []
        row = spool._db.execute("SELECT state FROM spool_records WHERE jobId = ?", ("job-1",)).fetchone()
        assert row[0] == "acknowledged"
        assert fake_coordinator["state"].completed == [{"jobId": "job-1", "captureId": "capture-1"}]
    finally:
        spool.close()


def test_process_uploads_retries_a_failed_upload_with_durable_backoff(tmp_path, fake_coordinator):
    """Part 15 'durable retry' - an upload failure moves the record to failed/ with a scheduled retry, not lost."""
    cfg = _make_config(tmp_path, fake_coordinator["url"])
    client = AgentProtocolClient(fake_coordinator["url"], "pln_validtoken")
    spool = Spool(cfg.spool_root, max_spool_bytes=cfg.max_spool_bytes)
    spool.init()
    try:
        output_path = spool.pending_path("capture-2")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"\xff\xd8\xff")
        spool.record_captured("job-2", "capture-2", "assign-2", "source-2", output_path, "2026-01-01T00:00:00Z")

        # Point at an unreachable coordinator to force an upload failure.
        broken_client = AgentProtocolClient("http://127.0.0.1:1", "pln_validtoken")
        agent.process_uploads(cfg, broken_client, spool)

        row = spool._db.execute("SELECT state, attemptCount FROM spool_records WHERE jobId = ?", ("job-2",)).fetchone()
        assert row[0] == "failed"
        assert row[1] == 1
        # The file itself must still exist - a failed upload never loses the capture.
        remaining_path = spool._db.execute("SELECT localFilePath FROM spool_records WHERE jobId = ?", ("job-2",)).fetchone()[0]
        assert Path(remaining_path).exists()
    finally:
        spool.close()
