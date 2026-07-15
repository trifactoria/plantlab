import { NextResponse } from "next/server";
import { createSupportBundleJob, serializeSupportBundleJob, type SupportBundleRequest, type SupportBundleScope } from "@/lib/operations/supportBundleJobs";

const SCOPES: SupportBundleScope[] = ["coordinator", "nodes", "all"];
const SCREENSHOT_MODES = ["none", "fixture", "live-readonly"] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const scope = SCOPES.includes(body.scope as SupportBundleScope) ? (body.scope as SupportBundleScope) : "coordinator";
  const screenshots = (SCREENSHOT_MODES as readonly string[]).includes(String(body.screenshots)) ? (body.screenshots as (typeof SCREENSHOT_MODES)[number]) : "none";
  const nodes = Array.isArray(body.nodes) ? body.nodes.filter((node): node is string => typeof node === "string").slice(0, 8) : [];

  if (scope === "nodes" && nodes.length === 0) {
    return NextResponse.json({ error: "Select at least one node." }, { status: 400 });
  }

  const supportRequest: SupportBundleRequest = {
    scope,
    nodes,
    screenshots,
    includeLogs: body.includeLogs !== false,
    includeHardwareTests: body.includeHardwareTests === true,
  };

  const job = createSupportBundleJob(supportRequest);
  return NextResponse.json({ job: serializeSupportBundleJob(job) }, { status: 202 });
}
