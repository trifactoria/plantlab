import { NextResponse } from "next/server";
import { capturePreviewImage } from "@/lib/camera";
import { productionLocalOnlyResponse } from "@/lib/localOnly";

export const runtime = "nodejs";

const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

type Context = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const { projectId } = await context.params;

  if (process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1") {
    return new Response(Buffer.from(TINY_JPEG_BASE64, "base64"), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  }

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
