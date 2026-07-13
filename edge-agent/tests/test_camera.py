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
        if args[0] == "v4l2-ctl" and "--all" in args:
            return _completed(stdout="Device Caps: Video Capture\n")
        if args[0] == "v4l2-ctl" and "--list-formats-ext" in args:
            return _completed(stdout="[0]: 'MJPG' (Motion-JPEG)\n  Size: Discrete 1280x720\n")
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


def test_discover_cameras_groups_duplicate_video_nodes_and_prefers_capture_node():
    def fake_run(args, **kwargs):
        device = args[args.index("--device") + 1] if "--device" in args else ""
        if args[0] == "v4l2-ctl" and "--info" in args:
            return _completed(stdout="Card type: Integrated Webcam\n")
        if args[0] == "v4l2-ctl" and "--all" in args:
            return _completed(stdout="Device Caps: Video Capture\n" if device == "/dev/video0" else "Device Caps: Metadata Capture\n")
        if args[0] == "v4l2-ctl" and "--list-formats-ext" in args:
            return _completed(stdout="[0]: 'MJPG' (Motion-JPEG)\n  Size: Discrete 1280x720\n")
        if args[0] == "udevadm":
            return _completed(stdout="ID_VENDOR_ID=0c45\nID_MODEL_ID=6a15\nID_SERIAL_SHORT=ABC123\n")
        return _completed()

    with patch("glob.glob", return_value=["/dev/video0", "/dev/video1"]), patch.object(camera, "command_exists", return_value=True), patch(
        "subprocess.run", side_effect=fake_run
    ):
        cameras = camera.discover_cameras()
        assert len(cameras) == 1
        assert cameras[0].device == "/dev/video0"
        assert cameras[0].alternate_devices == ["/dev/video1"]


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


# All three fixtures below are real `v4l2-ctl -d <device> --all` output
# recorded from actual hardware (bokchoy's Integrated_Webcam_HD and
# greenhouse-zero's Raspberry Pi ISP/codec devices), not hand-written - this
# is the exact text that drove the real onboarding bugs being fixed.


def test_caps_indicate_video_capture_recognizes_a_real_capture_device():
    """bokchoy /dev/video0."""
    output = "\n".join(
        [
            "Driver Info:",
            "\tDriver name      : uvcvideo",
            "\tCard type        : webcam 1080P: webcam 1080P",
            "\tBus info         : usb-20980000.usb-1.3",
            "\tDriver version   : 6.18.34",
            "\tCapabilities     : 0x84a00001",
            "\t\tVideo Capture",
            "\t\tMetadata Capture",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
            "\t\tDevice Capabilities",
            "\tDevice Caps      : 0x04200001",
            "\t\tVideo Capture",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
        ]
    )
    assert camera._caps_indicate_video_capture(output) is True


def test_caps_indicate_video_capture_rejects_metadata_only_node_despite_misleading_aggregate_capabilities():
    """bokchoy /dev/video1 - the aggregate Capabilities block lists "Video
    Capture" even though this specific node cannot capture (only its own
    Device Caps block is authoritative)."""
    output = "\n".join(
        [
            "Driver Info:",
            "\tDriver name      : uvcvideo",
            "\tCard type        : Integrated_Webcam_HD: Integrate",
            "\tBus info         : usb-0000:00:14.0-5",
            "\tDriver version   : 7.0.6",
            "\tCapabilities     : 0x84a00001",
            "\t\tVideo Capture",
            "\t\tMetadata Capture",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
            "\t\tDevice Capabilities",
            "\tDevice Caps      : 0x04a00000",
            "\t\tMetadata Capture",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
        ]
    )
    assert camera._caps_indicate_video_capture(output) is False


def test_caps_indicate_video_capture_rejects_memory_to_memory_codec_device_despite_format_section_header_text():
    """greenhouse-zero bcm2835-codec-decode - a memory-to-memory hardware
    codec, not a real camera, even though `--all` also prints a "Format
    Video Capture Multiplanar:" section header containing the literal
    substring "Video Capture" for its current format."""
    output = "\n".join(
        [
            "Driver Info:",
            "\tDriver name      : bcm2835-codec",
            "\tCard type        : bcm2835-codec-decode",
            "\tBus info         : platform:bcm2835-codec",
            "\tDriver version   : 6.18.34",
            "\tCapabilities     : 0x84204000",
            "\t\tVideo Memory-to-Memory Multiplanar",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
            "\t\tDevice Capabilities",
            "\tDevice Caps      : 0x04204000",
            "\t\tVideo Memory-to-Memory Multiplanar",
            "\t\tStreaming",
            "\t\tExtended Pix Format",
            "Priority: 2",
            "Format Video Capture Multiplanar:",
            "\tWidth/Height      : 32/32",
            "\tPixel Format      : 'YU12' (Planar YUV 4:2:0)",
        ]
    )
    assert camera._caps_indicate_video_capture(output) is False


def test_caps_indicate_video_capture_returns_false_when_no_caps_block_present():
    assert camera._caps_indicate_video_capture("Driver Info:\n\tDriver name      : nonsense\n") is False
