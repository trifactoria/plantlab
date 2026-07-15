import { NextResponse } from "next/server";

/**
 * True when this process is allowed to discover or execute against local
 * camera/V4L2 hardware. This is an execution/discovery boundary only; it
 * must not hide fleet management for attached-node cameras.
 */
export function canDiscoverLocalCameraHardware(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  return process.env.PLANTLAB_LOCAL_CAMERA_ENABLED === "1" || process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1";
}

/** Compatibility alias for existing local-execution callers. */
export function localCameraHardwareEnabled(): boolean {
  return canDiscoverLocalCameraHardware();
}

/** PlantLab is currently a trusted home-lab system, so fleet management is always visible. */
export function canManageFleetHardware(): boolean {
  return true;
}

export function productionLocalOnlyResponse() {
  if (canDiscoverLocalCameraHardware()) {
    return null;
  }

  return NextResponse.json(
    {
      error:
        "Local camera features are unavailable on this deployment. Set PLANTLAB_LOCAL_CAMERA_ENABLED=1 to enable them on a machine with an attached camera.",
    },
    { status: 403 },
  );
}
