import { formatCheckLine } from "../lib/startupChecks";
import { DOCTOR_CATEGORIES, DOCTOR_CATEGORY_LABELS, type DoctorReport } from "../lib/operations/doctor";

export { formatCheckLine };

/** Shared by `plantlab doctor` (terminal) - see src/app/api/health/route.ts for the JSON equivalent consumed by the web dashboard. Both start from the same runDoctorReport(). */
export function printDoctorReport(report: DoctorReport, logger: Pick<Console, "log"> = console): void {
  logger.log("Resolved paths:");
  for (const [key, value] of Object.entries(report.paths)) {
    logger.log(`  ${key}: ${value}`);
  }
  logger.log("");

  for (const category of DOCTOR_CATEGORIES) {
    const checks = report.byCategory[category];
    if (checks.length === 0) continue;

    logger.log(`${DOCTOR_CATEGORY_LABELS[category]}:`);
    for (const check of checks) {
      logger.log(`  ${formatCheckLine(check)}`);
    }
    logger.log("");
  }

  const { total, passCount, warnCount, failCount } = report.summary;
  logger.log(`${total} checks: ${passCount} passed, ${warnCount} warned, ${failCount} failed.`);
}
