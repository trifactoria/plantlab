import { NextResponse } from "next/server";

/**
 * True when this process is allowed to touch local camera/V4L2 hardware.
 *
 * Always true outside production (next dev, vitest, playwright dev-mode
 * runs). In production this requires an explicit opt-in: PlantLab's
 * intended production deployment (see DEPLOYMENT.md) is a single local
 * machine with a physically attached camera, run as two long-running
 * processes (the web app and the camera/scheduler service) via systemd -
 * not a publicly hosted, multi-tenant server where exposing hardware
 * access by default would be unsafe. The systemd unit / environment file
 * for that machine is expected to set PLANTLAB_LOCAL_CAMERA_ENABLED=1.
 *
 * PLANTLAB_TEST_LOCAL_CAMERA_UI is kept as a recognized alias so existing
 * production-mode e2e/screenshot tooling (scripts/playwright-dev-server.mjs)
 * keeps working unchanged.
 */
export function localCameraHardwareEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  return process.env.PLANTLAB_LOCAL_CAMERA_ENABLED === "1" || process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1";
}

export function productionLocalOnlyResponse() {
  if (localCameraHardwareEnabled()) {
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
