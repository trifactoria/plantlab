import { NextResponse } from "next/server";
import { productionLocalOnlyResponse } from "@/lib/localOnly";
import { runDoctorReport } from "@/lib/operations/doctor";

export const runtime = "nodejs";

/**
 * The web-facing half of the shared doctor service - see
 * src/lib/operations/doctor.ts's module doc comment. `plantlab doctor`
 * (terminal output) and this route (JSON) both call runDoctorReport();
 * neither re-implements any check. Never triggers a real hardware test
 * capture (that stays an explicit `plantlab doctor --capture`/`plantlab
 * camera test` opt-in only, never automatic from an HTTP poll).
 */
export async function GET() {
  const blocked = productionLocalOnlyResponse();
  if (blocked) {
    return blocked;
  }

  const report = await runDoctorReport();
  return NextResponse.json(report, { status: report.summary.ok ? 200 : 503 });
}
