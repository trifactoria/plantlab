import { NextResponse } from "next/server";
import { getSupportBundleJob, serializeSupportBundleJob } from "@/lib/operations/supportBundleJobs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = getSupportBundleJob(jobId);
  if (!job) return NextResponse.json({ error: "Support bundle job not found." }, { status: 404 });
  return NextResponse.json({ job: serializeSupportBundleJob(job) });
}
