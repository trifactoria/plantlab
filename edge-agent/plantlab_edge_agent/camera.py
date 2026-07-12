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
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
CAPTURE_TIMEOUT_SECONDS = 15


@dataclass
class CameraInfo:
    device: str
    name: Optional[str]
    stable_id: Optional[str]
    supports_capture: bool = True
    formats: List[str] = field(default_factory=list)
    alternate_devices: List[str] = field(default_factory=list)


def command_exists(name: str) -> bool:
    return subprocess.run(["sh", "-c", f"command -v {name}"], capture_output=True).returncode == 0


def raspicam_tools_available() -> bool:
    """Opportunistic detection only - see module docstring. Never affects USB camera discovery."""
    return command_exists("libcamera-hello") or command_exists("rpicam-hello")


def discover_cameras() -> List[CameraInfo]:
    """USB/V4L2 cameras via /dev/video* + v4l2-ctl, mirroring the shape (not the exact stable-ID algorithm) of src/lib/v4l2.ts's discoverLocalCameras(). Falls back to bare device-path discovery if v4l2-ctl is missing - never raises."""
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
        formats = _format_lines(device) if supports_capture else []
        cameras.append(CameraInfo(device=device, name=name, stable_id=stable_id, supports_capture=supports_capture, formats=formats))
    return _group_physical_cameras(cameras)


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


def _supports_capture(device: str) -> bool:
    result = subprocess.run(["v4l2-ctl", "--device", device, "--all"], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return False
    return "Video Capture" in result.stdout or "Video Capture Multiplanar" in result.stdout


def _format_lines(device: str) -> List[str]:
    result = subprocess.run(["v4l2-ctl", "--device", device, "--list-formats-ext"], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if "Size: Discrete" in line or re.search(r"\[\d+\]:", line)]


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
    normalized = (input_format or "mjpeg").lower()
    if normalized in ("mjpeg", "yuyv422", "yuyv"):
        return "mjpeg" if normalized == "mjpeg" else "yuyv422"
    return "mjpeg"
