import { NextResponse } from "next/server";
import { captureProjectPhoto } from "@/lib/camera";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function POST(_request: Request, context: Context) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Local camera capture is disabled in production." },
      { status: 403 },
    );
  }

  const { projectId } = await context.params;

  try {
    const result = await captureProjectPhoto(projectId);

    return NextResponse.json({
      photo: result.photo,
      savedPath: result.savedPath,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not capture photo";
    const status = message.startsWith("Project not found") ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
