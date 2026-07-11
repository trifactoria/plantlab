import { NextResponse } from "next/server";
import { captureProjectPhoto } from "@/lib/camera";
import { CameraBusyError } from "@/lib/cameraLock";
import { readJson } from "@/lib/http";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function POST(request: Request, context: Context) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Local camera capture is disabled in production." },
      { status: 403 },
    );
  }

  const { projectId } = await context.params;
  const body = await readJson(request);

  try {
    const result = await captureProjectPhoto(projectId, {
      notes: typeof body?.notes === "string" ? body.notes : null,
    });

    return NextResponse.json({
      photo: result.photo,
      savedPath: result.savedPath,
    });
  } catch (error) {
    if (error instanceof CameraBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    const message =
      error instanceof Error ? error.message : "Could not capture photo";
    const status = message.startsWith("Project not found") ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
