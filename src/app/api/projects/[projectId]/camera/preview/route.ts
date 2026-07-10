import { NextResponse } from "next/server";
import { capturePreviewImage } from "@/lib/camera";
import { productionLocalOnlyResponse } from "@/lib/localOnly";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;

  try {
    const image = await capturePreviewImage(projectId);
    return new Response(image, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not capture preview";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
