from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from . import camera

CACHE_VERSION = 1
CACHE_FILENAME = "camera-inventory-cache.json"
LOCK_FILENAME = "camera-inventory-refresh.lock"


class InventoryRefreshInProgress(Exception):
    pass


@dataclass(frozen=True)
class CameraInventoryCache:
    cameras: list[dict]
    verified_at: str
    written_at_monotonic_hint: Optional[float] = None


def cache_path(spool_root: str) -> Path:
    return Path(spool_root) / CACHE_FILENAME


def lock_path(spool_root: str) -> Path:
    return Path(spool_root) / LOCK_FILENAME


def camera_to_inventory_payload(c: camera.CameraInfo) -> dict:
    return {
        "stableId": c.stable_id or f"device:{c.device}",
        "legacyStableId": c.legacy_stable_id,
        "devicePath": c.device,
        "name": c.name,
        "vendorId": c.vendor_id,
        "productId": c.product_id,
        "serial": c.serial,
        "physicalPath": c.physical_path,
        "usbPath": c.usb_path,
        "usbPort": c.usb_port,
        "alternateDevices": c.alternate_devices,
        "available": c.verified_capture is True,
        "formats": c.formats,
        "formatsStatus": c.formats_status,
        "formatsError": c.formats_error,
        "verifiedProbeMode": c.verified_format,
        "captureProbeError": c.capture_probe_error,
    }


def load_camera_inventory_cache(spool_root: str) -> CameraInventoryCache | None:
    path = cache_path(spool_root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict) or raw.get("version") != CACHE_VERSION:
        return None
    cameras = raw.get("cameras")
    verified_at = raw.get("verifiedAt")
    if not isinstance(cameras, list) or not isinstance(verified_at, str):
        return None
    safe_cameras = [item for item in cameras if isinstance(item, dict)]
    return CameraInventoryCache(
        cameras=safe_cameras,
        verified_at=verified_at,
        written_at_monotonic_hint=raw.get("writtenAtMonotonic") if isinstance(raw.get("writtenAtMonotonic"), (int, float)) else None,
    )


def write_camera_inventory_cache(spool_root: str, cameras: list[dict], verified_at: str) -> Path:
    root = Path(spool_root)
    root.mkdir(parents=True, exist_ok=True)
    path = cache_path(spool_root)
    payload = {
        "version": CACHE_VERSION,
        "verifiedAt": verified_at,
        "writtenAtMonotonic": time.monotonic(),
        "cameras": cameras,
    }
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return path


def camera_inventory_cache_status(spool_root: str) -> dict:
    path = cache_path(spool_root)
    cache = load_camera_inventory_cache(spool_root)
    if not cache:
        return {
            "path": str(path),
            "present": path.exists(),
            "valid": False,
            "cameraCount": 0,
            "verifiedAt": None,
            "ageSeconds": None,
        }
    age_seconds = None
    if cache.written_at_monotonic_hint is not None:
        age_seconds = max(0.0, time.monotonic() - cache.written_at_monotonic_hint)
    return {
        "path": str(path),
        "present": True,
        "valid": True,
        "cameraCount": len(cache.cameras),
        "verifiedAt": cache.verified_at,
        "ageSeconds": age_seconds,
    }


@contextmanager
def inventory_refresh_lock(spool_root: str) -> Iterator[None]:
    import fcntl

    path = lock_path(spool_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InventoryRefreshInProgress("Camera inventory refresh is already running.") from exc
        try:
            f.write(f"{os.getpid()}\n")
            f.flush()
            yield
        finally:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass


def inventory_refresh_running(spool_root: str) -> bool:
    try:
        with inventory_refresh_lock(spool_root):
            return False
    except InventoryRefreshInProgress:
        return True
