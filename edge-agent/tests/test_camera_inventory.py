import json

import pytest

from plantlab_edge_agent import camera
from plantlab_edge_agent.camera_inventory import (
    InventoryRefreshInProgress,
    camera_inventory_cache_status,
    camera_to_inventory_payload,
    inventory_refresh_lock,
    load_camera_inventory_cache,
    write_camera_inventory_cache,
)


def test_camera_inventory_cache_round_trip(tmp_path):
    payload = [
        camera_to_inventory_payload(
            camera.CameraInfo(
                device="/dev/video0",
                name="Test Cam",
                stable_id="usb:test",
                vendor_id="32e6",
                product_id="9221",
                serial="duplicate",
                physical_path="platform-20980000.usb-usb-0:1.3",
                verified_capture=True,
                formats=[{"pixelFormat": "mjpeg", "resolutions": [{"width": 1280, "height": 720, "frameRates": ["30 fps"]}]}],
                verified_format={"pixelFormat": "mjpeg", "width": 1280, "height": 720},
            )
        )
    ]

    path = write_camera_inventory_cache(str(tmp_path), payload, "2026-07-13T15:30:00Z")
    loaded = load_camera_inventory_cache(str(tmp_path))

    assert path.exists()
    assert loaded is not None
    assert loaded.verified_at == "2026-07-13T15:30:00Z"
    assert loaded.cameras[0]["stableId"] == "usb:test"
    assert loaded.cameras[0]["devicePath"] == "/dev/video0"
    assert loaded.cameras[0]["verifiedProbeMode"] == {"pixelFormat": "mjpeg", "width": 1280, "height": 720}
    status = camera_inventory_cache_status(str(tmp_path))
    assert status["valid"] is True
    assert status["cameraCount"] == 1


def test_invalid_camera_inventory_cache_is_ignored(tmp_path):
    (tmp_path / "camera-inventory-cache.json").write_text(json.dumps({"version": 999, "cameras": []}))
    assert load_camera_inventory_cache(str(tmp_path)) is None
    status = camera_inventory_cache_status(str(tmp_path))
    assert status["present"] is True
    assert status["valid"] is False


def test_inventory_refresh_lock_prevents_overlap(tmp_path):
    with inventory_refresh_lock(str(tmp_path)):
        with pytest.raises(InventoryRefreshInProgress):
            with inventory_refresh_lock(str(tmp_path)):
                pass
