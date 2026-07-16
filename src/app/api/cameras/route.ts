import { NextResponse } from "next/server";
import { canDiscoverLocalCameraHardware } from "@/lib/localOnly";
import { discoverLocalCameras } from "@/lib/v4l2";

export const runtime = "nodejs";

export async function GET() {
  if (!canDiscoverLocalCameraHardware()) return NextResponse.json({ cameras: [] });

  if (process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1") {
    return NextResponse.json({
      cameras: [
        {
          name: "Mock USB Camera",
          device: "/dev/video-test",
          supportsCapture: true,
          stableId: "usb:1234:5678:MOCKSERIAL",
        },
      ],
    });
  }

  try {
    const cameras = await discoverLocalCameras();
    return NextResponse.json({ cameras });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list cameras";
    return NextResponse.json({ error: message, cameras: [] }, { status: 400 });
  }
}
