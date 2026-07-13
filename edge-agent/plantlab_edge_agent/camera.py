"""USB/V4L2 camera support for the edge agent - Part 10 of the Pi Zero task.

Initially USB/V4L2 webcams only, through ffmpeg + v4l2-ctl (both external
binaries, no Python bindings needed). Raspberry Pi camera-module tools
(libcamera/rpicam) are detected opportunistically but never required - see
Part 10 "do not require them."

No video streaming - one manual capture job at a time, conservative
defaults (see DEFAULT_WIDTH/DEFAULT_HEIGHT), single JPEG frame.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
CAPTURE_TIMEOUT_SECONDS = 15
CAPTURE_PROBE_TIMEOUT_SECONDS = 8
CONSERVATIVE_FALLBACK_WIDTH = 640
CONSERVATIVE_FALLBACK_HEIGHT = 480


@dataclass
class CameraInfo:
    device: str
    name: Optional[str]
    stable_id: Optional[str]
    supports_capture: bool = True
    formats: List[Dict[str, object]] = field(default_factory=list)
    formats_status: str = "unknown"
    formats_error: Optional[str] = None
    alternate_devices: List[str] = field(default_factory=list)
    # Part 5: whether a real, short ffmpeg one-frame capture actually
    # succeeded on this device - never assume reported V4L2 capabilities
    # mean a device can actually be opened for streaming. The real bokchoy
    # failure: two /dev/video* nodes shared one physical camera and one USB
    # identity; only one could actually be opened by ffmpeg
    # (VIDIOC_G_INPUT: Inappropriate ioctl for device on the other).
    verified_capture: bool = False
    # Part 6: the exact pixel format/resolution the probe succeeded with -
    # never offer/assign a combination that was never actually proven to
    # work. None when verified_capture is False.
    verified_format: Optional[Dict[str, object]] = None
    capture_probe_error: Optional[str] = None
    # device -> failure reason, for alternates that were actually probed
    # (not just skipped because metadata already ruled them out).
    alternate_probe_errors: Dict[str, str] = field(default_factory=dict)


def command_exists(name: str) -> bool:
    return subprocess.run(["sh", "-c", f"command -v {name}"], capture_output=True).returncode == 0


def raspicam_tools_available() -> bool:
    """Opportunistic detection only - see module docstring. Never affects USB camera discovery."""
    return command_exists("libcamera-hello") or command_exists("rpicam-hello")


def discover_cameras(probe_capture: bool = True) -> List[CameraInfo]:
    """USB/V4L2 cameras via /dev/video* + v4l2-ctl, mirroring the shape (not the exact stable-ID algorithm) of src/lib/v4l2.ts's discoverLocalCameras(). Falls back to bare device-path discovery if v4l2-ctl is missing - never raises.

    ``probe_capture=True`` (the default - Part 5) additionally performs a
    real, short, serialized ffmpeg one-frame capture probe against every
    metadata-plausible candidate in a stable-identity group, selecting the
    device that actually captures successfully as primary rather than
    trusting reported V4L2 capabilities alone. Set False only for callers
    that explicitly want the cheaper metadata-only grouping (e.g. a fast
    listing where hardware access isn't wanted).
    """
    devices = sorted(glob.glob("/dev/video*"))
    if not devices:
        return []

    if not command_exists("v4l2-ctl"):
        return [CameraInfo(device=d, name=None, stable_id=None) for d in devices]

    cameras: List[CameraInfo] = []
    for device in devices:
        name = _v4l2_card_name(device)
        stable_id = _stable_id_for_device(device)
        supports_capture = _supports_capture(device)
        formats, formats_status, formats_error = _list_camera_formats(device) if supports_capture else ([], "unavailable", None)
        cameras.append(
            CameraInfo(
                device=device,
                name=name,
                stable_id=stable_id,
                supports_capture=supports_capture,
                formats=formats,
                formats_status=formats_status,
                formats_error=formats_error,
            )
        )

    return _verify_camera_groups(cameras) if probe_capture else _group_physical_cameras(cameras)


def _verify_camera_groups(cameras: List[CameraInfo]) -> List[CameraInfo]:
    """Part 5: real verified-capture selection. Groups by the same stable-identity key as _group_physical_cameras() (kept separately, pure/metadata-only, for its own tests), then - one device at a time, serialized, never in parallel - probes every metadata-plausible candidate in score order. The first one that actually captures becomes primary; every other device in the group is recorded as an alternate, annotated with its real probe failure reason when one was attempted."""
    groups: "dict[str, List[CameraInfo]]" = {}
    for cam in cameras:
        groups.setdefault(cam.stable_id or f"device:{cam.device}", []).append(cam)

    result: List[CameraInfo] = []
    for group in groups.values():
        ordered = sorted(group, key=lambda c: (-_camera_score(c), _device_sort_key(c.device)))

        attempts: "dict[str, Tuple[bool, str, Optional[dict]]]" = {}
        winner: Optional[CameraInfo] = None
        for candidate in ordered:
            if not candidate.supports_capture:
                continue
            ok, detail, fmt = _probe_device_capture(candidate.device, candidate.formats)
            attempts[candidate.device] = (ok, detail, fmt)
            if ok and winner is None:
                candidate.verified_capture = True
                candidate.verified_format = fmt
                candidate.capture_probe_error = None
                winner = candidate

        primary = winner or ordered[0]
        if winner is None:
            attempt = attempts.get(primary.device)
            primary.verified_capture = False
            primary.verified_format = None
            primary.capture_probe_error = attempt[1] if attempt else None

        primary.alternate_devices = [c.device for c in ordered if c.device != primary.device]
        primary.alternate_probe_errors = {
            c.device: attempts[c.device][1] for c in ordered if c.device != primary.device and c.device in attempts and not attempts[c.device][0]
        }
        result.append(primary)

    return sorted(result, key=lambda c: _device_sort_key(c.device))


def _group_physical_cameras(cameras: List[CameraInfo]) -> List[CameraInfo]:
    groups: dict[str, List[CameraInfo]] = {}
    for cam in cameras:
        groups.setdefault(cam.stable_id or f"device:{cam.device}", []).append(cam)
    grouped: List[CameraInfo] = []
    for group in groups.values():
        # Keep numeric device order as the tie breaker, ascending.
        ordered = sorted(group, key=lambda c: (-_camera_score(c), _device_sort_key(c.device)))
        primary = ordered[0]
        primary.alternate_devices = [c.device for c in ordered[1:]]
        grouped.append(primary)
    return sorted(grouped, key=lambda c: _device_sort_key(c.device))


def _camera_score(camera: CameraInfo) -> int:
    return (10 if camera.supports_capture else 0) + (20 if camera.formats else 0)


def _device_sort_key(device: str) -> int:
    match = re.search(r"(\d+)$", device)
    return int(match.group(1)) if match else 10_000


def _v4l2_card_name(device: str) -> Optional[str]:
    result = subprocess.run(["v4l2-ctl", "--device", device, "--info"], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return None
    match = re.search(r"Card type\s*:\s*(.+)", result.stdout)
    return match.group(1).strip() if match else None


def _extract_caps_block(v4l2_ctl_all_output: str, label: str) -> Optional[str]:
    """Extracts just the capability names listed under a "Device Caps" or
    "Capabilities" block in `v4l2-ctl --all` output (each capability is a
    line indented one level deeper than the block's own header line, e.g.
    "\tDevice Caps      : 0x04200001\n\t\tVideo Capture\n\t\tStreaming").
    Returns None when that block isn't present at all."""
    lines = v4l2_ctl_all_output.split("\n")
    header_pattern = re.compile(rf"^\t{re.escape(label)}\s*:")
    header_index = next((i for i, line in enumerate(lines) if header_pattern.match(line)), None)
    if header_index is None:
        return None
    collected: List[str] = []
    for line in lines[header_index + 1 :]:
        if not re.match(r"^\t\t\S", line):
            break
        collected.append(line.strip())
    return "\n".join(collected)


def _caps_indicate_video_capture(v4l2_ctl_all_output: str) -> bool:
    """Pure, hardware-free so it can be unit tested with recorded output.
    Only the "Device Caps" block (falling back to the aggregate
    "Capabilities" block when absent) reflects a node's real functional
    capability - `--all` also prints a "Format Video Capture Multiplanar:"
    *section header* for the current format of a memory-to-memory device's
    queue (e.g. a Raspberry Pi's bcm2835-codec-decode/isp hardware), which
    contains the literal substring "Video Capture" even though the device
    cannot actually capture from a sensor - a naive whole-output substring
    match incorrectly treated every one of those as a real camera."""
    caps_block = _extract_caps_block(v4l2_ctl_all_output, "Device Caps") or _extract_caps_block(v4l2_ctl_all_output, "Capabilities")
    if not caps_block:
        return False
    if "Memory-to-Memory" in caps_block:
        return False
    return "Video Capture" in caps_block


def _supports_capture(device: str) -> bool:
    result = subprocess.run(["v4l2-ctl", "--device", device, "--all"], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return False
    return _caps_indicate_video_capture(result.stdout)


def _normalize_input_format(input_format: str) -> str:
    normalized = (input_format or "").strip().lower()
    if normalized in ("mjpg", "mjpeg", "jpeg"):
        return "mjpeg"
    if normalized in ("yuyv", "yuyv422"):
        return "yuyv422"
    return normalized or "mjpeg"


def _list_camera_formats(device: str) -> Tuple[List[Dict[str, object]], str, Optional[str]]:
    try:
        result = subprocess.run(["v4l2-ctl", "--device", device, "--list-formats-ext"], capture_output=True, text=True, timeout=5)
    except Exception as exc:
        return [], "error", str(exc)
    if result.returncode != 0:
        return [], "error", result.stderr.strip()[:500] or f"v4l2-ctl exited with code {result.returncode}"
    return _parse_formats_output(result.stdout), "ok", None


def _parse_formats_output(output: str) -> List[Dict[str, object]]:
    formats: List[Dict[str, object]] = []
    current_format: Optional[Dict[str, object]] = None
    current_resolution: Optional[Dict[str, object]] = None

    for line in output.splitlines():
        format_match = re.search(r"\[\d+\]:\s+'([^']+)'\s+\(([^)]+)\)", line)
        if format_match:
            pixel_format = _normalize_input_format(format_match.group(1))
            current_format = next((fmt for fmt in formats if fmt.get("pixelFormat") == pixel_format), None)
            if current_format is None:
                current_format = {"pixelFormat": pixel_format, "description": format_match.group(2).strip(), "resolutions": []}
                formats.append(current_format)
            current_resolution = None
            continue

        size_match = re.search(r"Size:\s+Discrete\s+(\d+)x(\d+)", line)
        if size_match and current_format is not None:
            resolutions = current_format["resolutions"]
            assert isinstance(resolutions, list)
            width = int(size_match.group(1))
            height = int(size_match.group(2))
            current_resolution = next((res for res in resolutions if res.get("width") == width and res.get("height") == height), None)
            if current_resolution is None:
                current_resolution = {"width": width, "height": height, "frameRates": []}
                resolutions.append(current_resolution)
            continue

        interval_match = re.search(r"Interval:\s+Discrete\s+[^()]*\(([^)]+)\)", line)
        if interval_match and current_resolution is not None:
            frame_rates = current_resolution["frameRates"]
            assert isinstance(frame_rates, list)
            rate = interval_match.group(1).strip()
            if rate not in frame_rates:
                frame_rates.append(rate)

    return formats


def _stable_id_for_device(device: str) -> Optional[str]:
    """Best-effort USB-based stable id via udevadm, when available - falls back to the raw device path (still unique per boot, just not stable across USB port changes) rather than failing discovery outright."""
    if not command_exists("udevadm"):
        return None
    result = subprocess.run(["udevadm", "info", "--query=property", "--name", device], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return None
    props = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    vendor = props.get("ID_VENDOR_ID")
    model = props.get("ID_MODEL_ID")
    serial = props.get("ID_SERIAL_SHORT") or props.get("ID_SERIAL")
    if vendor and model:
        return f"usb:{vendor}:{model}:{serial or 'noserial'}"
    return None


def _build_probe_candidates(formats: List[Dict[str, object]]) -> List[Tuple[str, int, int]]:
    """Builds tuple-preserving probe candidates from parsed V4L2 formats - prefers MJPEG at the highest reported resolution, then falls back conservatively only if needed."""
    parsed: List[Tuple[str, int, int, List[str]]] = []
    for fmt in formats:
        pixel_format = _normalize_input_format(str(fmt.get("pixelFormat") or ""))
        resolutions = fmt.get("resolutions")
        if not isinstance(resolutions, list):
            continue
        for resolution in resolutions:
            if not isinstance(resolution, dict):
                continue
            width = resolution.get("width")
            height = resolution.get("height")
            frame_rates = resolution.get("frameRates")
            if isinstance(width, int) and isinstance(height, int):
                parsed.append((pixel_format, width, height, frame_rates if isinstance(frame_rates, list) else []))

    candidates: List[Tuple[str, int, int]] = []
    preferred = sorted(
        parsed,
        key=lambda item: (
            0 if item[0] == "mjpeg" else 1,
            -(item[1] * item[2]),
            0 if any(re.search(r"(?:^|\D)30(?:\.0+)?\s*fps", str(rate), re.I) for rate in item[3]) else 1,
        ),
    )[:1]
    candidates.extend((pixel_format, width, height) for pixel_format, width, height, _ in preferred)
    if not any(w == CONSERVATIVE_FALLBACK_WIDTH and h == CONSERVATIVE_FALLBACK_HEIGHT for _, w, h in candidates):
        candidates.append(("mjpeg", CONSERVATIVE_FALLBACK_WIDTH, CONSERVATIVE_FALLBACK_HEIGHT))
    return candidates


def _probe_device_capture(device: str, formats: List[Dict[str, object]]) -> Tuple[bool, str, Optional[Dict[str, object]]]:
    """Tries each candidate format/resolution in order, stopping at the first real success (Part 5 point 4 plus point 8's 640x480 fallback)."""
    candidates = _build_probe_candidates(formats)
    last_detail = "No capture candidates were available to probe."
    for pixel_format, width, height in candidates:
        ok, detail = _attempt_one_frame_capture(device, pixel_format, width, height)
        if ok:
            return True, detail, {"pixelFormat": _normalize_input_format(pixel_format), "width": width, "height": height}
        last_detail = detail
    return False, last_detail, None


def _attempt_one_frame_capture(device: str, pixel_format: str, width: int, height: int) -> Tuple[bool, str]:
    """One real, short, serialized ffmpeg capture into a throwaway temp file - never canonical project/capture data, always cleaned up, always externally timed out in case the device hangs rather than erroring quickly."""
    fd, tmp_path = tempfile.mkstemp(prefix="plantlab-capture-probe-", suffix=".jpg")
    os.close(fd)
    try:
        args = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "v4l2",
            "-input_format",
            _ffmpeg_input_format(pixel_format),
            "-video_size",
            f"{width}x{height}",
            "-i",
            device,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            "-y",
            tmp_path,
        ]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=CAPTURE_PROBE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return False, f"ffmpeg capture probe on {device} timed out after {CAPTURE_PROBE_TIMEOUT_SECONDS}s."
        if result.returncode != 0:
            return False, (result.stderr.strip()[:500] or f"ffmpeg exited with code {result.returncode}")
        path_obj = Path(tmp_path)
        if not path_obj.exists() or path_obj.stat().st_size == 0:
            return False, "ffmpeg reported success but produced an empty or missing file."
        with open(tmp_path, "rb") as f:
            head = f.read(2)
        if head != b"\xff\xd8":
            return False, "Output file does not look like a valid JPEG."
        return True, f"Verified {width}x{height} {pixel_format.upper()} capture."
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def capture_frame(device: str, output_path: str, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT, input_format: str = "mjpeg") -> None:
    """Single-frame capture via ffmpeg - same command shape as src/lib/camera.ts's buildFfmpegArgs(), simplified (no warmup option - the edge agent's manual capture job is a one-shot test, not a scheduled series)."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    args = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-input_format",
        _ffmpeg_input_format(input_format),
        "-video_size",
        f"{width}x{height}",
        "-i",
        device,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        output_path,
    ]
    result = subprocess.run(args, capture_output=True, text=True, timeout=CAPTURE_TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg capture from {device} failed: {result.stderr.strip()[:500]}")
    if not Path(output_path).exists() or Path(output_path).stat().st_size == 0:
        raise RuntimeError(f"ffmpeg reported success but {output_path} is missing or empty.")


def _ffmpeg_input_format(input_format: str) -> str:
    return _normalize_input_format(input_format)
