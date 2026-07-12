import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyStorageRemediation,
  DOCTOR_CATEGORIES,
  DOCTOR_CATEGORY_LABELS,
  runDoctorReport,
  runStorageAudit,
} from "../../src/lib/operations/doctor";
import { resolveIngestDir } from "../../src/lib/paths.server";
import { prisma } from "../../src/lib/prisma";

describe("operations/doctor", () => {
  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe("runDoctorReport", () => {
    it("returns a well-formed report covering every documented category, with a consistent summary", async () => {
      const report = await runDoctorReport();

      expect(report.checks.length).toBeGreaterThan(0);
      expect(DOCTOR_CATEGORIES.every((category) => category in report.byCategory)).toBe(true);
      expect(Object.keys(DOCTOR_CATEGORY_LABELS)).toEqual(DOCTOR_CATEGORIES);

      const flattened = DOCTOR_CATEGORIES.flatMap((category) => report.byCategory[category]);
      expect(flattened).toHaveLength(report.checks.length);

      const passCount = report.checks.filter((c) => c.status === "pass").length;
      const warnCount = report.checks.filter((c) => c.status === "warn").length;
      const failCount = report.checks.filter((c) => c.status === "fail").length;
      expect(report.summary).toEqual({
        ok: failCount === 0,
        total: report.checks.length,
        passCount,
        warnCount,
        failCount,
      });
    });

    it("reports test-capture as skipped (warn) when --capture is not requested", async () => {
      const report = await runDoctorReport();
      const testCapture = report.checks.find((c) => c.name === "test-capture");
      expect(testCapture?.status).toBe("warn");
      expect(testCapture?.detail).toMatch(/Skipped/);
    });

    it("reports no role configured (warn) before plantlab install has run in this isolated root", async () => {
      const report = await runDoctorReport();
      const nodeStatus = report.checks.find((c) => c.name === "node-role");
      expect(nodeStatus?.status).toBe("warn");
      expect(nodeStatus?.category).toBe("nodeStatus");
    });

    it("reports no backups found (warn) in a fresh isolated root", async () => {
      const report = await runDoctorReport();
      const backups = report.checks.find((c) => c.name === "backups");
      expect(backups?.status).toBe("warn");
      expect(backups?.category).toBe("backups");
    });
  });

  describe("runStorageAudit / applyStorageRemediation", () => {
    it("surfaces the same project-directory and ingest-file audits dataDoctor.server already provides", async () => {
      const ingestDir = resolveIngestDir();
      await mkdir(ingestDir, { recursive: true });
      const stalePath = path.join(ingestDir, "leftover.partial");
      await writeFile(stalePath, "partial upload bytes");

      const report = await runStorageAudit({ minAgeMs: 0 });
      expect(report.ingestFiles.staleFiles.map((f) => f.filePath)).toContain(stalePath);

      const remediation = await applyStorageRemediation(report, { removeStaleIngestFiles: true });
      expect(remediation.staleIngestFiles?.removed).toContain(stalePath);
      expect(remediation.emptyOrphans).toBeUndefined();
    });

    it("applyStorageRemediation does nothing when no remediation flags are set", async () => {
      const report = await runStorageAudit();
      const remediation = await applyStorageRemediation(report, {});
      expect(remediation).toEqual({});
    });
  });
});
