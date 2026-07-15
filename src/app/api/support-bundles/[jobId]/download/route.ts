import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSupportBundleJob } from "@/lib/operations/supportBundleJobs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = getSupportBundleJob(jobId);
  if (!job) return NextResponse.json({ error: "Support bundle job not found." }, { status: 404 });
  if (!job.result || !job.zipPath) return NextResponse.json({ error: "The support bundle is not ready to download yet." }, { status: 409 });

  try {
    const data = await readFile(job.zipPath);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${path.basename(job.zipPath)}"`,
        "content-length": String(data.byteLength),
      },
    });
  } catch {
    return NextResponse.json({ error: "The support bundle file is no longer available." }, { status: 410 });
  }
}
