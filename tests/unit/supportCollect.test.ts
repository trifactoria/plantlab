import { describe, expect, it } from "vitest";
import { redact, selectedHosts, summarizeHostStatus } from "../../src/lib/operations/supportCollect";

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
