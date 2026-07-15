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
import json
import math
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
CAPTURE_TIMEOUT_SECONDS = 15
CAPTURE_PROBE_TIMEOUT_SECONDS = 8
CONSERVATIVE_FALLBACK_WIDTH = 640
CONSERVATIVE_FALLBACK_HEIGHT = 480
DEFAULT_WARMUP_FRAMES = 10
DEFAULT_CAPTURE_ATTEMPTS = 2
DEFAULT_FALLBACK_ATTEMPTS = 1


@dataclass
class CameraInfo:
    device: str
    name: Optional[str]
    stable_id: Optional[str]
    legacy_stable_id: Optional[str] = None
    vendor_id: Optional[str] = None
    product_id: Optional[str] = None
    serial: Optional[str] = None
    physical_path: Optional[str] = None
    usb_path: Optional[str] = None
    usb_port: Optional[str] = None
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


@dataclass
class CaptureMode:
    width: int
    height: int
    input_format: str = "mjpeg"
    frame_rate: Optional[str] = None


@dataclass
class CaptureAttempt:
    mode: CaptureMode
    attempt: int
    fallback: bool
    started_at: str
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    status: str = "failed"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    byte_size: Optional[int] = None


@dataclass
class CaptureResult:
    output_path: str
    captured_at: str
    capture_started_at: str
    frame_captured_at: str
    capture_duration_ms: int
    attempts: List[CaptureAttempt]
    effective_mode: CaptureMode
    warmup_frames: int
    fallback_used: bool
    validation_status: str = "accepted"
    validation_error_code: Optional[str] = None

    def metadata(self) -> Dict[str, object]:
        return {
            "captureStartedAt": self.capture_started_at,
            "frameCapturedAt": self.frame_captured_at,
            "captureDurationMs": self.capture_duration_ms,
            "effectiveWidth": self.effective_mode.width,
            "effectiveHeight": self.effective_mode.height,
            "effectiveInputFormat": _normalize_input_format(self.effective_mode.input_format),
            "effectiveFrameRate": self.effective_mode.frame_rate,
            "warmupFrames": self.warmup_frames,
            "attemptCount": len(self.attempts),
            "fallbackUsed": self.fallback_used,
            "validationStatus": self.validation_status,
            "validationErrorCode": self.validation_error_code,
            "attempts": [
                {
                    "mode": attempt.mode.__dict__,
                    "attempt": attempt.attempt,
                    "fallback": attempt.fallback,
                    "startedAt": attempt.started_at,
                    "completedAt": attempt.completed_at,
                    "durationMs": attempt.duration_ms,
                    "status": attempt.status,
                    "errorCode": attempt.error_code,
                    "errorMessage": attempt.error_message,
                    "byteSize": attempt.byte_size,
                }
                for attempt in self.attempts
            ],
        }


class CaptureValidationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


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

    raw: List[Tuple[str, Optional[str], Dict[str, Optional[str]], bool, List[Dict[str, object]], str, Optional[str]]] = []
    for device in devices:
        name = _v4l2_card_name(device)
        identity = _identity_for_device(device)
        supports_capture = _supports_capture(device)
        formats, formats_status, formats_error = _list_camera_formats(device) if supports_capture else ([], "unavailable", None)
        raw.append((device, name, identity, supports_capture, formats, formats_status, formats_error))

    duplicate_serials = _duplicated_serial_keys([entry[2] for entry in raw])
    cameras: List[CameraInfo] = []
    for device, name, identity, supports_capture, formats, formats_status, formats_error in raw:
        serial_key = _serial_key(identity)
        duplicate_serial = serial_key in duplicate_serials if serial_key else False
        stable_id = _stable_id_from_identity(identity, duplicate_serial=duplicate_serial)
        physical_path = identity.get("physicalPath")
        cameras.append(
            CameraInfo(
                device=device,
                name=_display_name(name, physical_path),
                stable_id=stable_id,
                legacy_stable_id=_legacy_stable_id(identity),
                vendor_id=identity.get("vendorId"),
                product_id=identity.get("productId"),
                serial=identity.get("serial"),
                physical_path=physical_path,
                usb_path=physical_path,
                usb_port=_usb_path_suffix(physical_path),
                supports_capture=supports_capture,
                formats=formats,
                formats_status=formats_status,
                formats_error=formats_error,
            )
        )

    return _verify_camera_groups(cameras) if probe_capture else _group_physical_cameras(cameras)


def discover_camera_metadata() -> List[CameraInfo]:
    """Metadata-only camera grouping. Does not run ffmpeg capture probes."""
    return discover_cameras(probe_capture=False)


def verify_camera_metadata(cameras: List[CameraInfo]) -> List[CameraInfo]:
    """Run serialized ffmpeg verification against already-collected metadata."""
    return _verify_camera_groups(cameras)


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


def _parse_properties(output: str) -> Dict[str, str]:
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def _normalize_physical_path(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    normalized = value.strip()
    normalized = re.sub(r"/video4linux/video\d+$", "", normalized, flags=re.I)
    normalized = re.sub(r"(\d+-\d+(?:\.\d+)*):\d+\.\d+$", r"\1", normalized, flags=re.I)
    normalized = re.sub(r"(:\d+(?:\.\d+)+):\d+\.\d+$", r"\1", normalized, flags=re.I)
    return normalized or None


def _usb_path_suffix(physical_path: Optional[str]) -> Optional[str]:
    normalized = _normalize_physical_path(physical_path)
    if not normalized:
        return None
    match = re.search(r":(\d+(?:\.\d+)*)$", normalized)
    if match:
        return match.group(1)
    match = re.search(r"\d+-(\d+(?:\.\d+)*)$", normalized)
    if match:
        return match.group(1)
    return normalized.rstrip("/").split("/")[-1]


def _display_name(name: Optional[str], physical_path: Optional[str]) -> Optional[str]:
    suffix = _usb_path_suffix(physical_path)
    if not name or not suffix or f"({suffix})" in name or f"USB path {suffix}" in name:
        return name
    return f"{name} ({suffix})"


def _identity_for_device(device: str) -> Dict[str, Optional[str]]:
    """Best-effort USB identity via udevadm. The normalized physical path
    intentionally drops the interface suffix (for example ':1.0') so sibling
    V4L2 nodes from one UVC webcam share one identity."""
    if not command_exists("udevadm"):
        return {"vendorId": None, "productId": None, "serial": None, "physicalPath": None}
    result = subprocess.run(["udevadm", "info", "--query=property", "--name", device], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return {"vendorId": None, "productId": None, "serial": None, "physicalPath": None}
    props = _parse_properties(result.stdout)
    vendor = props.get("ID_VENDOR_ID")
    product = props.get("ID_MODEL_ID")
    serial = props.get("ID_SERIAL_SHORT") or props.get("ID_SERIAL")
    physical_path = _normalize_physical_path(props.get("ID_PATH")) or _normalize_physical_path(props.get("DEVPATH"))
    return {"vendorId": vendor, "productId": product, "serial": serial, "physicalPath": physical_path}


def _serial_key(identity: Dict[str, Optional[str]]) -> Optional[str]:
    vendor = identity.get("vendorId")
    product = identity.get("productId")
    serial = identity.get("serial")
    if not vendor or not product or not serial:
        return None
    return f"{vendor}:{product}:{serial}"


def _duplicated_serial_keys(identities: List[Dict[str, Optional[str]]]) -> set[str]:
    paths_by_serial: Dict[str, set[str]] = {}
    for identity in identities:
        key = _serial_key(identity)
        path_value = identity.get("physicalPath")
        if not key or not path_value:
            continue
        paths_by_serial.setdefault(key, set()).add(path_value)
    return {key for key, paths in paths_by_serial.items() if len(paths) > 1}


def _legacy_stable_id(identity: Dict[str, Optional[str]]) -> Optional[str]:
    vendor = identity.get("vendorId")
    product = identity.get("productId")
    serial = identity.get("serial")
    if vendor and product:
        return f"usb:{vendor}:{product}:{serial or 'noserial'}"
    return None


def _stable_id_from_identity(identity: Dict[str, Optional[str]], duplicate_serial: bool = False) -> Optional[str]:
    base = _legacy_stable_id(identity)
    physical_path = identity.get("physicalPath")
    serial = identity.get("serial")
    if base and (duplicate_serial or not serial):
        return f"{base}:path:{physical_path}" if physical_path else base
    return base


def _stable_id_for_device(device: str) -> Optional[str]:
    identity = _identity_for_device(device)
    return _stable_id_from_identity(identity)


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


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_fps(frame_rate: Optional[str]) -> Optional[float]:
    if not frame_rate:
        return None
    match = re.search(r"(\d+(?:\.\d+)?)", frame_rate)
    if not match:
        return None
    value = float(match.group(1))
    return value if value > 0 else None


def _frame_rate_arg(frame_rate: Optional[str]) -> Optional[str]:
    fps = _parse_fps(frame_rate)
    if not fps:
        return None
    return str(int(fps)) if fps.is_integer() else f"{fps:.3f}".rstrip("0").rstrip(".")


def _capture_timeout(mode: CaptureMode, warmup_frames: int, warmup_seconds: Optional[float]) -> int:
    fps = _parse_fps(mode.frame_rate) or 30.0
    warmup_from_frames = warmup_frames / fps if warmup_frames > 0 else 0
    warmup = max(warmup_from_frames, warmup_seconds or 0)
    return max(CAPTURE_TIMEOUT_SECONDS, int(math.ceil(warmup + 12)))


def build_capture_args(device: str, output_path: str, mode: CaptureMode, warmup_frames: int = DEFAULT_WARMUP_FRAMES) -> List[str]:
    args = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
    ]
    frame_rate = _frame_rate_arg(mode.frame_rate)
    if frame_rate:
        args.extend(["-framerate", frame_rate])
    args.extend(
        [
            "-input_format",
            _ffmpeg_input_format(mode.input_format),
            "-video_size",
            f"{mode.width}x{mode.height}",
            "-i",
            device,
        ]
    )
    if warmup_frames > 0:
        args.extend(["-vf", f"select=gte(n\\,{warmup_frames})"])
    args.extend(["-frames:v", "1", "-q:v", "2", "-y", output_path])
    return args


def _minimum_expected_jpeg_bytes(width: int, height: int) -> int:
    return max(12000, round(width * height * 0.03))


def _luma_stats(rgb: bytes) -> Tuple[float, float, int, float]:
    values: List[int] = []
    histogram = [0] * 256
    total = 0
    min_value = 255
    max_value = 0
    for index in range(0, len(rgb) - 2, 3):
        luma = round(0.2126 * rgb[index] + 0.7152 * rgb[index + 1] + 0.0722 * rgb[index + 2])
        values.append(luma)
        histogram[luma] += 1
        total += luma
        min_value = min(min_value, luma)
        max_value = max(max_value, luma)
    count = max(1, len(values))
    mean = total / count
    variance = sum((value - mean) ** 2 for value in values) / count
    entropy = 0.0
    for bucket in histogram:
        if bucket:
            p = bucket / count
            entropy -= p * math.log2(p)
    return mean, math.sqrt(variance), max_value - min_value, entropy


def validate_capture_file(path: str, expected: CaptureMode) -> Dict[str, object]:
    image = Path(path)
    if not image.exists() or image.stat().st_size <= 0:
        raise CaptureValidationError("camera-output-empty", "ffmpeg produced an empty or missing file.")
    byte_size = image.stat().st_size

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name",
            "-of",
            "json",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=8,
    )
    if probe.returncode != 0:
        raise CaptureValidationError("camera-jpeg-invalid", probe.stderr.strip()[:500] or "ffprobe could not decode the image.")
    try:
        stream = json.loads(probe.stdout)["streams"][0]
    except Exception as exc:
        raise CaptureValidationError("camera-jpeg-invalid", f"ffprobe output did not include an image stream: {exc}")

    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width != expected.width or height != expected.height:
        raise CaptureValidationError("camera-dimension-mismatch", f"Captured {width}x{height}; expected {expected.width}x{expected.height}.")

    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", "scale=64:64,format=rgb24", "-f", "rawvideo", "-"],
        capture_output=True,
        timeout=10,
    )
    if decoded.returncode != 0 or not decoded.stdout:
        detail = decoded.stderr.decode("utf-8", "replace").strip()[:500]
        raise CaptureValidationError("camera-jpeg-invalid", detail or "ffmpeg could not fully decode the image.")

    mean, stddev, luma_range, entropy = _luma_stats(decoded.stdout)
    suspiciously_small = width * height >= 300000 and byte_size < _minimum_expected_jpeg_bytes(width, height)
    low_detail = stddev < 6 or luma_range < 32 or entropy < 1.2
    if suspiciously_small and low_detail:
        raise CaptureValidationError(
            "camera-frame-corrupt",
            f"Image decoded but looked like a corrupt or unsettled frame ({byte_size} bytes, luma stddev {stddev:.2f}).",
        )

    return {
        "width": width,
        "height": height,
        "byteSize": byte_size,
        "lumaMean": round(mean, 2),
        "lumaStdDev": round(stddev, 2),
        "lumaRange": luma_range,
        "lumaEntropy": round(entropy, 3),
    }


def _attempt_capture(device: str, output_path: str, mode: CaptureMode, warmup_frames: int, warmup_seconds: Optional[float], attempt_number: int, fallback: bool) -> CaptureAttempt:
    started_monotonic = time.monotonic()
    started_at = _now_iso()
    attempt = CaptureAttempt(mode=mode, attempt=attempt_number, fallback=fallback, started_at=started_at)
    Path(output_path).unlink(missing_ok=True)
    args = build_capture_args(device, output_path, mode, warmup_frames=warmup_frames)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=_capture_timeout(mode, warmup_frames, warmup_seconds))
        if result.returncode != 0:
            raise CaptureValidationError("camera-open-failed", result.stderr.strip()[:500] or f"ffmpeg exited with code {result.returncode}")
        stats = validate_capture_file(output_path, mode)
        attempt.status = "accepted"
        attempt.byte_size = int(stats["byteSize"])
    except subprocess.TimeoutExpired:
        attempt.error_code = "camera-timeout"
        attempt.error_message = f"ffmpeg capture timed out after {_capture_timeout(mode, warmup_frames, warmup_seconds)}s."
    except CaptureValidationError as exc:
        attempt.error_code = exc.code
        attempt.error_message = str(exc)
    finally:
        attempt.completed_at = _now_iso()
        attempt.duration_ms = round((time.monotonic() - started_monotonic) * 1000)
    return attempt


def capture_frame_with_result(
    device: str,
    output_path: str,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    input_format: str = "mjpeg",
    frame_rate: Optional[str] = None,
    warmup_frames: int = DEFAULT_WARMUP_FRAMES,
    warmup_seconds: Optional[float] = None,
    capture_attempts: int = DEFAULT_CAPTURE_ATTEMPTS,
    fallback_mode: Optional[CaptureMode] = None,
    fallback_attempts: int = DEFAULT_FALLBACK_ATTEMPTS,
) -> CaptureResult:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    primary = CaptureMode(width=width, height=height, input_format=input_format, frame_rate=frame_rate)
    attempts: List[CaptureAttempt] = []
    started_monotonic = time.monotonic()
    started_at = _now_iso()

    sequences: List[Tuple[CaptureMode, int, bool]] = [(primary, max(1, capture_attempts), False)]
    if fallback_mode is not None and fallback_attempts > 0:
        sequences.append((fallback_mode, fallback_attempts, True))

    for mode, count, fallback in sequences:
        for _ in range(count):
            attempt = _attempt_capture(device, output_path, mode, warmup_frames, warmup_seconds, len(attempts) + 1, fallback)
            attempts.append(attempt)
            if attempt.status == "accepted":
                frame_at = attempt.completed_at or _now_iso()
                return CaptureResult(
                    output_path=output_path,
                    captured_at=frame_at,
                    capture_started_at=started_at,
                    frame_captured_at=frame_at,
                    capture_duration_ms=round((time.monotonic() - started_monotonic) * 1000),
                    attempts=attempts,
                    effective_mode=mode,
                    warmup_frames=warmup_frames,
                    fallback_used=fallback,
                )
            if not fallback:
                time.sleep(0.5)

    Path(output_path).unlink(missing_ok=True)
    last = attempts[-1] if attempts else None
    reason = last.error_message if last else "No capture attempts ran."
    raise RuntimeError(f"camera-fallback-exhausted: {reason}")


def capture_frame(device: str, output_path: str, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT, input_format: str = "mjpeg") -> None:
    capture_frame_with_result(device, output_path, width=width, height=height, input_format=input_format)
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
