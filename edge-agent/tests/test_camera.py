import subprocess
from unittest.mock import patch

import pytest

from plantlab_edge_agent import camera


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_discover_cameras_returns_empty_list_when_no_video_devices():
    with patch("glob.glob", return_value=[]):
        assert camera.discover_cameras() == []


def test_discover_cameras_falls_back_to_bare_device_paths_without_v4l2_ctl():
    with patch("glob.glob", return_value=["/dev/video0"]), patch.object(camera, "command_exists", return_value=False):
        cameras = camera.discover_cameras()
        assert len(cameras) == 1
        assert cameras[0].device == "/dev/video0"
        assert cameras[0].name is None
        assert cameras[0].stable_id is None


def test_discover_cameras_reports_name_and_stable_id_when_tools_available():
    def fake_run(args, **kwargs):
        if args[0] == "v4l2-ctl" and "--info" in args:
            return _completed(stdout="Card type: Logitech C270\n")
        if args[0] == "udevadm":
            return _completed(stdout="ID_VENDOR_ID=046d\nID_MODEL_ID=0825\nID_SERIAL_SHORT=ABC123\n")
        return _completed()

    with patch("glob.glob", return_value=["/dev/video0"]), patch.object(camera, "command_exists", return_value=True), patch(
        "subprocess.run", side_effect=fake_run
    ):
        cameras = camera.discover_cameras()
        assert len(cameras) == 1
        assert cameras[0].name == "Logitech C270"
        assert cameras[0].stable_id == "usb:046d:0825:ABC123"


def test_capture_frame_raises_when_ffmpeg_fails(tmp_path):
    output = tmp_path / "out.jpg"
    with patch("subprocess.run", return_value=_completed(returncode=1, stderr="No such device")):
        with pytest.raises(RuntimeError, match="ffmpeg capture"):
            camera.capture_frame("/dev/video0", str(output))


def test_capture_frame_raises_when_ffmpeg_reports_success_but_wrote_nothing(tmp_path):
    output = tmp_path / "out.jpg"
    with patch("subprocess.run", return_value=_completed(returncode=0)):
        with pytest.raises(RuntimeError, match="missing or empty"):
            camera.capture_frame("/dev/video0", str(output))


def test_capture_frame_succeeds_and_uses_conservative_default_resolution(tmp_path):
    output = tmp_path / "out.jpg"

    def fake_run(args, **kwargs):
        output.write_bytes(b"\xff\xd8\xff")  # minimal JPEG-looking bytes
        assert f"{camera.DEFAULT_WIDTH}x{camera.DEFAULT_HEIGHT}" in args
        return _completed(returncode=0)

    with patch("subprocess.run", side_effect=fake_run):
        camera.capture_frame("/dev/video0", str(output))
    assert output.exists()
    assert output.stat().st_size > 0


def test_raspicam_tools_are_never_required_only_opportunistically_detected():
    with patch.object(camera, "command_exists", return_value=False):
        assert camera.raspicam_tools_available() is False  # must not raise even when absent
