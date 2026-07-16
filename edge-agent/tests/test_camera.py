import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from plantlab_edge_agent import camera
from plantlab_edge_agent import __main__ as edge_cli


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def _capture_attempt(status="failed", attempt=1, fallback=False, code="partial-frame"):
    result = camera.CaptureAttempt(
        mode=camera.CaptureMode(width=1920 if not fallback else 1280, height=1080 if not fallback else 720, input_format="mjpeg"),
        attempt=attempt,
        fallback=fallback,
        started_at="2026-07-16T17:25:22Z",
    )
    result.completed_at = "2026-07-16T17:25:38Z"
    result.duration_ms = 100
    result.status = status
    result.byte_size = 123456
    result.sha256 = "a" * 64
    result.validation_stats = {"horizontalEdgeScore": 30, "horizontalSplitLumaDelta": 55, "horizontalSplitChannelDelta": 40}
    if status != "accepted":
        result.error_code = code
        result.error_message = "Image decoded but contains a horizontal split-frame discontinuity."
    return result


def test_split_frame_stats_detect_obvious_horizontal_channel_discontinuity():
    width = 128
    height = 72
    raw = bytearray(width * height * 3)
    for y in range(height):
        for x in range(width):
            index = (y * width + x) * 3
            texture = (x * 17 + y * 31 + ((x * y) % 53)) % 80
            raw[index] = 70 + texture
            raw[index + 1] = 95 + ((texture + x) % 95)
            raw[index + 2] = 55 + ((texture + y) % 70)
            if y >= int(height * 0.34):
                raw[index] = min(255, raw[index] + 75)
                raw[index + 1] = min(255, raw[index + 1] + 110)
                raw[index + 2] = max(0, raw[index + 2] - 35)

    stats = camera._split_frame_stats(bytes(raw), width, height)
    assert stats["horizontalEdgeScore"] >= 24
    assert stats["horizontalSplitLumaDelta"] >= 35
    assert stats["horizontalSplitChannelDelta"] >= 20


def test_capture_retries_primary_before_fallback_and_keeps_primary_mode(tmp_path):
    output = tmp_path / "out.jpg"
    attempts = [_capture_attempt(attempt=1), _capture_attempt(status="accepted", attempt=2)]
    with patch.object(camera, "_attempt_capture", side_effect=attempts) as mocked:
        result = camera.capture_frame_with_result(
            "/dev/video0",
            str(output),
            width=1920,
            height=1080,
            capture_attempts=2,
            fallback_mode=camera.CaptureMode(width=1280, height=720),
            fallback_attempts=1,
        )

    assert mocked.call_count == 2
    assert result.fallback_used is False
    assert result.effective_mode.width == 1920
    assert result.attempts[0].error_code == "partial-frame"
    assert result.attempts[1].status == "accepted"


def test_capture_uses_fallback_only_after_primary_retries_fail(tmp_path):
    output = tmp_path / "out.jpg"
    attempts = [_capture_attempt(attempt=1), _capture_attempt(attempt=2), _capture_attempt(status="accepted", attempt=3, fallback=True)]
    with patch.object(camera, "_attempt_capture", side_effect=attempts) as mocked:
        result = camera.capture_frame_with_result(
            "/dev/video0",
            str(output),
            width=1920,
            height=1080,
            capture_attempts=2,
            fallback_mode=camera.CaptureMode(width=1280, height=720),
            fallback_attempts=1,
        )

    assert mocked.call_count == 3
    assert result.fallback_used is True
    assert result.effective_mode.width == 1280


def test_capture_failure_preserves_rejected_attempt_diagnostics(tmp_path):
    output = tmp_path / "out.jpg"
    attempts = [_capture_attempt(attempt=1), _capture_attempt(attempt=2), _capture_attempt(attempt=3, fallback=True)]
    with patch.object(camera, "_attempt_capture", side_effect=attempts):
        with pytest.raises(camera.CaptureFailedError) as exc:
            camera.capture_frame_with_result(
                "/dev/video0",
                str(output),
                width=1920,
                height=1080,
                capture_attempts=2,
                fallback_mode=camera.CaptureMode(width=1280, height=720),
                fallback_attempts=1,
            )

    metadata = exc.value.metadata()
    assert metadata["validationStatus"] == "rejected"
    assert metadata["validationErrorCode"] == "partial-frame"
    assert metadata["attemptCount"] == 3
    assert metadata["attempts"][0]["validationStats"]["horizontalEdgeScore"] == 30


def test_rejected_attempt_preserves_local_diagnostic_artifact(tmp_path):
    output = tmp_path / "spool" / "pending" / "capture-1.jpg"

    def fake_run(args, **kwargs):
        if args[0] == "ffmpeg" and args[-1] == str(output):
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"bad-jpeg-evidence")
            return _completed(returncode=0)
        return _completed(returncode=0)

    with patch("subprocess.run", side_effect=fake_run), patch.object(
        camera,
        "validate_capture_file",
        side_effect=camera.CaptureValidationError("partial-frame", "split frame", {"horizontalEdgeScore": 30}),
    ):
        attempt = camera._attempt_capture("/dev/video0", str(output), camera.CaptureMode(width=1920, height=1080), 10, None, 1, False)

    assert attempt.error_code == "partial-frame"
    assert attempt.sha256 is not None
    assert attempt.rejected_artifact_path is not None
    artifact = Path(attempt.rejected_artifact_path)
    assert artifact.exists()
    assert artifact.read_bytes() == b"bad-jpeg-evidence"
    assert artifact.parts[-4:] == ("diagnostics", "rejected-captures", artifact.parts[-2], "capture-1-attempt-1.jpg")


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


def test_edge_camera_list_verbose_and_json_show_modes_and_probe_details(capsys):
    formats = [
        {
            "pixelFormat": "mjpeg",
            "description": "Motion-JPEG",
            "resolutions": [{"width": 1920, "height": 1080, "frameRates": ["30 fps"]}],
        },
        {
            "pixelFormat": "yuyv422",
            "description": "YUYV 4:2:2",
            "resolutions": [{"width": 640, "height": 480, "frameRates": ["30 fps"]}],
        },
    ]
    fake_camera = camera.CameraInfo(
        device="/dev/video0",
        name="Greenhouse Camera",
        stable_id="usb:greenhouse-zero",
        supports_capture=True,
        verified_capture=True,
        verified_format={"pixelFormat": "mjpeg", "width": 1920, "height": 1080},
        formats=formats,
        formats_status="ok",
        alternate_devices=["/dev/video1"],
        alternate_probe_errors={"/dev/video1": "metadata-only device"},
    )

    with patch.object(camera, "discover_cameras", return_value=[fake_camera]):
        assert edge_cli.main(["camera", "list", "--verbose"]) == 0
    verbose = capsys.readouterr().out
    assert "Physical camera: usb:greenhouse-zero" in verbose
    assert "Primary device: /dev/video0" in verbose
    assert "Verified probe mode: MJPEG 1920x1080" in verbose
    assert "/dev/video1 - probe failed: metadata-only device" in verbose
    assert "MJPEG 1920x1080 @ 30 fps" in verbose
    assert "YUYV 640x480 @ 30 fps" in verbose

    with patch.object(camera, "discover_cameras", return_value=[fake_camera]):
        assert edge_cli.main(["camera", "list", "--json"]) == 0
    json_output = capsys.readouterr().out
    assert '"physicalCamera": "usb:greenhouse-zero"' in json_output
    assert '"verifiedPrimaryDevice": "/dev/video0"' in json_output
    assert '"pixelFormat": "mjpeg"' in json_output


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


def test_discover_cameras_splits_duplicate_serial_webcams_by_usb_path_and_groups_sibling_nodes():
    def fake_run(args, **kwargs):
        device = args[args.index("--device") + 1] if "--device" in args else args[-1]
        if args[0] == "v4l2-ctl" and "--info" in args:
            return _completed(stdout="Card type: webcam 1080P\n")
        if args[0] == "v4l2-ctl" and "--all" in args:
            return _completed(stdout="Device Caps: Video Capture\n" if device in ("/dev/video0", "/dev/video2") else "Device Caps: Metadata Capture\n")
        if args[0] == "v4l2-ctl" and "--list-formats-ext" in args:
            return _completed(stdout="[0]: 'MJPG' (Motion-JPEG)\n  Size: Discrete 1280x720\n")
        if args[0] == "udevadm":
            path = "platform-20980000.usb-usb-0:1.3:1.0" if device in ("/dev/video0", "/dev/video1") else "platform-20980000.usb-usb-0:1.2:1.0"
            return _completed(
                stdout="\n".join(
                    [
                        "ID_VENDOR_ID=32e6",
                        "ID_MODEL_ID=9221",
                        "ID_SERIAL_SHORT=202601081445001",
                        f"ID_PATH={path}",
                    ]
                )
            )
        return _completed()

    with patch("glob.glob", return_value=["/dev/video0", "/dev/video1", "/dev/video2", "/dev/video3"]), patch.object(
        camera, "command_exists", return_value=True
    ), patch("subprocess.run", side_effect=fake_run):
        cameras = camera.discover_cameras(probe_capture=False)

    assert len(cameras) == 2
    assert cameras[0].device == "/dev/video0"
    assert cameras[0].alternate_devices == ["/dev/video1"]
    assert cameras[0].stable_id == "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.3"
    assert cameras[0].legacy_stable_id == "usb:32e6:9221:202601081445001"
    assert cameras[0].usb_port == "1.3"
    assert cameras[0].name == "webcam 1080P (1.3)"
    assert cameras[1].device == "/dev/video2"
    assert cameras[1].alternate_devices == ["/dev/video3"]
    assert cameras[1].stable_id == "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.2"
    assert cameras[1].usb_port == "1.2"


def test_identity_helpers_handle_unique_serial_missing_serial_and_hub_paths():
    unique = {"vendorId": "32e6", "productId": "9221", "serial": "REAL1", "physicalPath": "platform-20980000.usb-usb-0:1.3"}
    missing = {"vendorId": "32e6", "productId": "9221", "serial": None, "physicalPath": "platform-20980000.usb-usb-0:1.3"}

    assert camera._stable_id_from_identity(unique) == "usb:32e6:9221:REAL1"
    assert camera._stable_id_from_identity(missing) == "usb:32e6:9221:noserial:path:platform-20980000.usb-usb-0:1.3"
    assert camera._normalize_physical_path("pci-0000:00:14.0-usb-0:4.2.3:1.0") == "pci-0000:00:14.0-usb-0:4.2.3"
    assert camera._usb_path_suffix("pci-0000:00:14.0-usb-0:4.2.3:1.0") == "4.2.3"


def test_capture_frame_raises_when_ffmpeg_fails(tmp_path):
    output = tmp_path / "out.jpg"
    with patch("subprocess.run", return_value=_completed(returncode=1, stderr="No such device")):
        with pytest.raises(RuntimeError, match="camera-fallback-exhausted"):
            camera.capture_frame("/dev/video0", str(output))


def test_capture_frame_raises_when_ffmpeg_reports_success_but_wrote_nothing(tmp_path):
    output = tmp_path / "out.jpg"
    with patch("subprocess.run", return_value=_completed(returncode=0)):
        with pytest.raises(RuntimeError, match="empty or missing file"):
            camera.capture_frame("/dev/video0", str(output))


def test_capture_frame_succeeds_and_uses_conservative_default_resolution(tmp_path):
    output = tmp_path / "out.jpg"

    def fake_run(args, **kwargs):
        if args[0] == "ffmpeg" and args[-1] == str(output):
            output.write_bytes(b"x" * 100000)
            assert f"{camera.DEFAULT_WIDTH}x{camera.DEFAULT_HEIGHT}" in args
            return _completed(returncode=0)
        if args[0] == "ffprobe":
            return _completed(stdout='{"streams":[{"width":1280,"height":720,"codec_name":"mjpeg"}]}')
        if args[0] == "ffmpeg" and args[-1] == "-":
            sample_size = 128 * 72 * 3 if "scale=128:72,format=rgb24" in args else 64 * 64 * 3
            return subprocess.CompletedProcess(args=args, returncode=0, stdout=bytes([i % 256 for i in range(sample_size)]), stderr=b"")
        return _completed(returncode=0)

    with patch("subprocess.run", side_effect=fake_run):
        camera.capture_frame("/dev/video0", str(output))
    assert output.exists()
    assert output.stat().st_size > 0


def test_parse_formats_output_preserves_mjpg_and_yuyv_families():
    formats = camera._parse_formats_output(
        "\n".join(
            [
                "[0]: 'MJPG' (Motion-JPEG)",
                "  Size: Discrete 1280x720",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 960x540",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "[1]: 'YUYV' (YUYV 4:2:2)",
                "  Size: Discrete 640x480",
                "    Interval: Discrete 0.033s (30.000 fps)",
            ]
        )
    )

    assert formats == [
        {
            "pixelFormat": "mjpeg",
            "description": "Motion-JPEG",
            "resolutions": [
                {"width": 1280, "height": 720, "frameRates": ["30.000 fps"]},
                {"width": 960, "height": 540, "frameRates": ["30.000 fps"]},
            ],
        },
        {
            "pixelFormat": "yuyv422",
            "description": "YUYV 4:2:2",
            "resolutions": [{"width": 640, "height": 480, "frameRates": ["30.000 fps"]}],
        },
    ]


def test_parse_formats_output_preserves_greenhouse_zero_recorded_inventory():
    formats = camera._parse_formats_output(
        "\n".join(
            [
                "[0]: 'MJPG' (Motion-JPEG)",
                "  Size: Discrete 1920x1080",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 1280x720",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 800x600",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 640x480",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 640x360",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "[1]: 'YUYV' (YUYV 4:2:2)",
                "  Size: Discrete 1920x1080",
                "    Interval: Discrete 0.200s (5.000 fps)",
                "  Size: Discrete 1280x720",
                "    Interval: Discrete 0.100s (10.000 fps)",
                "  Size: Discrete 800x600",
                "    Interval: Discrete 0.050s (20.000 fps)",
                "  Size: Discrete 640x480",
                "    Interval: Discrete 0.033s (30.000 fps)",
                "  Size: Discrete 640x360",
                "    Interval: Discrete 0.033s (30.000 fps)",
            ]
        )
    )

    assert formats == [
        {
            "pixelFormat": "mjpeg",
            "description": "Motion-JPEG",
            "resolutions": [
                {"width": 1920, "height": 1080, "frameRates": ["30.000 fps"]},
                {"width": 1280, "height": 720, "frameRates": ["30.000 fps"]},
                {"width": 800, "height": 600, "frameRates": ["30.000 fps"]},
                {"width": 640, "height": 480, "frameRates": ["30.000 fps"]},
                {"width": 640, "height": 360, "frameRates": ["30.000 fps"]},
            ],
        },
        {
            "pixelFormat": "yuyv422",
            "description": "YUYV 4:2:2",
            "resolutions": [
                {"width": 1920, "height": 1080, "frameRates": ["5.000 fps"]},
                {"width": 1280, "height": 720, "frameRates": ["10.000 fps"]},
                {"width": 800, "height": 600, "frameRates": ["20.000 fps"]},
                {"width": 640, "height": 480, "frameRates": ["30.000 fps"]},
                {"width": 640, "height": 360, "frameRates": ["30.000 fps"]},
            ],
        },
    ]


def test_build_probe_candidates_prefers_highest_mjpeg_mode():
    formats = [
        {
            "pixelFormat": "mjpeg",
            "description": "Motion-JPEG",
            "resolutions": [
                {"width": 1280, "height": 720, "frameRates": ["30.000 fps"]},
                {"width": 1920, "height": 1080, "frameRates": ["30.000 fps"]},
            ],
        },
        {
            "pixelFormat": "yuyv422",
            "description": "YUYV 4:2:2",
            "resolutions": [{"width": 640, "height": 480, "frameRates": ["30.000 fps"]}],
        },
    ]

    assert camera._build_probe_candidates(formats)[0] == ("mjpeg", 1920, 1080)


def test_capture_frame_normalizes_yuyv_to_ffmpeg_yuyv422(tmp_path):
    output = tmp_path / "out.jpg"
    captured_args = []

    def fake_run(args, **kwargs):
        if args[0] == "ffmpeg" and args[-1] == str(output):
            captured_args.extend(args)
            output.write_bytes(b"x" * 20000)
            return _completed(returncode=0)
        if args[0] == "ffprobe":
            return _completed(stdout='{"streams":[{"width":640,"height":480,"codec_name":"mjpeg"}]}')
        if args[0] == "ffmpeg" and args[-1] == "-":
            sample_size = 128 * 72 * 3 if "scale=128:72,format=rgb24" in args else 64 * 64 * 3
            return subprocess.CompletedProcess(args=args, returncode=0, stdout=bytes([i % 256 for i in range(sample_size)]), stderr=b"")
        return _completed(returncode=0)

    with patch("subprocess.run", side_effect=fake_run):
        camera.capture_frame("/dev/video0", str(output), width=640, height=480, input_format="YUYV")

    assert captured_args[captured_args.index("-input_format") + 1] == "yuyv422"


def test_build_capture_args_includes_warmup_select_and_frame_rate():
    args = camera.build_capture_args(
        "/dev/video0",
        "/tmp/out.jpg",
        camera.CaptureMode(width=1280, height=720, input_format="mjpeg", frame_rate="30.000 fps"),
        warmup_frames=10,
    )

    assert args[args.index("-framerate") + 1] == "30"
    assert args[args.index("-vf") + 1] == "select=gte(n\\,10)"
    assert args[args.index("-frames:v") + 1] == "1"


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
