import { describe, expect, it } from "vitest";
import { redact, selectedHosts, summarizeHostStatus } from "../../src/lib/operations/supportCollect";
import { buildSummaryMarkdown, evaluateProbeOutput, overallHealth } from "../../src/lib/operations/supportHealth";
import { discoverScreenshotRoutes } from "../../src/lib/operations/supportScreenshots";

describe("support collect", () => {
  it("redacts common credential shapes", () => {
    const redacted = redact(
      [
        "PLANTLAB_NODE_CREDENTIAL=abc123",
        'Authorization: Bearer secret.token',
        '"password": "hunter2"',
        "KASA_PASSWORD=supersecret",
      ].join("\n"),
    );
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("secret.token");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("[REDACTED]");
  });
});

type Probe = { host: string; role: string; command: string; ok: boolean; status: number | null; path: string };
function probe(ok: boolean): Probe {
  return { host: "h", role: "r", command: "c", ok, status: ok ? 0 : 1, path: "/x" };
}

describe("support bundle host selection", () => {
  it("coordinator-only selects just the coordinator", () => {
    expect(selectedHosts({ coordinator: "plantlab" }).map((host) => host.host)).toEqual(["plantlab"]);
  });

  it("all selects every default host", () => {
    const hosts = selectedHosts({ all: true }).map((host) => host.host);
    expect(hosts).toEqual(expect.arrayContaining(["xps", "plantlab", "greenhouse-zero", "bokchoy"]));
  });

  it("nodes scope includes the coordinator plus each selected node, de-duplicated and role-mapped", () => {
    const hosts = selectedHosts({ coordinator: "plantlab", nodes: ["greenhouse-zero", "bokchoy", "plantlab"] });
    const byHost = Object.fromEntries(hosts.map((host) => [host.host, host.role]));
    expect(byHost["greenhouse-zero"]).toBe("greenhouse-node");
    expect(byHost["bokchoy"]).toBe("camera-node");
    expect(byHost["plantlab"]).toBe("coordinator");
    expect(hosts.filter((host) => host.host === "plantlab").length).toBe(1);
  });

  it("maps an unknown node to a generic node role", () => {
    expect(selectedHosts({ nodes: ["some-new-node"] }).find((host) => host.host === "some-new-node")?.role).toBe("node");
  });
});

describe("summarizeHostStatus (one offline host yields partial, never aborts)", () => {
  it("succeeded when every probe passes", () => {
    expect(summarizeHostStatus([probe(true), probe(true)])).toBe("succeeded");
  });
  it("failed when no probe passes", () => {
    expect(summarizeHostStatus([probe(false), probe(false)])).toBe("failed");
  });
  it("partial when some probes pass and some fail", () => {
    expect(summarizeHostStatus([probe(true), probe(false)])).toBe("partial");
  });
  it("succeeded for an empty probe set", () => {
    expect(summarizeHostStatus([])).toBe("succeeded");
  });
});

describe("support health semantic findings", () => {
  it("treats failed systemd services as critical even when the shell command exits successfully", () => {
    const findings = evaluateProbeOutput(probe(true), "Loaded: loaded\nActive: failed (Result: exit-code)\n");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "critical",
          category: "services",
          title: "systemd service is failed",
        }),
      ]),
    );
  });

  it("treats an unreachable coordinator API as critical", () => {
    const findings = evaluateProbeOutput(
      { ...probe(false), command: "curl -fsS http://127.0.0.1:3000/api/health" },
      "curl: (7) Failed to connect: Connection refused",
    );
    expect(findings.some((finding) => finding.level === "critical" && finding.category === "probe")).toBe(true);
  });

  it("flags repeated corrupt camera frames as a warning", () => {
    const findings = evaluateProbeOutput(probe(true), "camera-frame-corrupt\nvalidationStatus rejected\n");
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ level: "warning", category: "cameras" })]));
  });

  it("does not classify one transient DHT22 miss as failed", () => {
    const findings = evaluateProbeOutput(probe(true), "DHT22 checksum failed once\n");
    expect(findings.filter((finding) => finding.category === "sensors")).toEqual([]);
    expect(overallHealth(findings, [probe(true)])).toBe("healthy");
  });

  it("builds a human-readable summary with criticals, warnings, screenshots, and failed probes", () => {
    const probes = [{ ...probe(false), host: "plantlab", path: "plantlab/api/health.json" }];
    const findings = evaluateProbeOutput(probes[0], "Connection refused");
    const summary = buildSummaryMarkdown({
      createdAt: "2026-07-16T12:00:00.000Z",
      invokedOn: "xps",
      screenshots: "live-readonly",
      probes,
      findings,
      screenshotsMetadata: [
        {
          route: "/",
          title: "PlantLab",
          host: "plantlab",
          viewport: { width: 1440, height: 1000 },
          capturedAt: "2026-07-16T12:00:01.000Z",
          httpStatus: 200,
          consoleErrors: [],
          networkErrors: [],
          outputFilename: "001-home.png",
          ready: true,
          readinessReason: null,
        },
      ],
      collectionOptions: {},
    });
    expect(summary).toContain("Overall health: critical");
    expect(summary).toContain("## Critical Findings");
    expect(summary).toContain("001-home.png");
    expect(summary).toContain("## Skipped Or Failed Probes");
  });
});

describe("support screenshot discovery", () => {
  it("discovers dashboard, node, project, photo, and capture-source surfaces without hardcoded greenhouse names", () => {
    const routes = discoverScreenshotRoutes({
      host: "plantlab",
      nodes: [{ name: "camera-rack", sensors: [{ key: "air" }], cameras: [{ id: "cam-1" }] }],
      projects: [{ id: "project-1", name: "Shelf A", photoId: "photo-1" }],
      captureSources: [{ id: "source-1", name: "Shelf camera" }],
      photos: [{ id: "photo-2" }],
    });
    expect(routes.map((route) => route.route)).toEqual(
      expect.arrayContaining([
        "/?tab=environment",
        "/?tab=projects",
        "/nodes/camera-rack",
        "/nodes/camera-rack/cameras",
        "/nodes/camera-rack/sensors",
        "/nodes/camera-rack/sensors/air",
        "/projects/project-1",
        "/projects/project-1/camera",
        "/projects/project-1/settings",
        "/photos/photo-1",
        "/capture-sources/source-1",
      ]),
    );
    expect(routes.some((route) => route.route.includes("greenhouse-zero"))).toBe(false);
  });
});
