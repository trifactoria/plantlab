import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildReadmeHtml,
  buildSummaryMarkdown,
  findingsForProbes,
  hostHealthSummary,
  normalizeEvidencePath,
  overallHealth,
  type ScreenshotMetadata,
  type SupportFinding,
  type SupportProbeLike,
  writeJson,
} from "./supportHealth";
import {
  discoverScreenshotRoutes,
  summarizeScreenshotMetadata,
  writeScreenshotRouteManifest,
  type SupportScreenshotDiscoverySnapshot,
  type SupportScreenshotRoute,
} from "./supportScreenshots";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportCollect.ts is server-only operational code.");
}

export type ScreenshotMode = "fixture" | "live-readonly" | "none";

export type SupportTargetStatus = "queued" | "collecting" | "succeeded" | "partial" | "failed";

export type SupportProgressEvent =
  | { type: "target-start"; host: string; role: string }
  | { type: "target-done"; host: string; role: string; status: SupportTargetStatus }
  | { type: "screenshots-start"; mode: ScreenshotMode }
  | { type: "screenshots-done"; ok: boolean };

export type SupportCollectOptions = {
  node?: string | null;
  /** One or more explicit node hosts to include (structured, never a shelled string). */
  nodes?: string[];
  coordinator?: string | null;
  all?: boolean;
  screenshots?: ScreenshotMode;
  includeLogs?: boolean;
  /** Intrusive per-sensor hardware probes on the edge node. Off by default. */
  includeHardwareTests?: boolean;
  outputDir?: string;
  onProgress?: (event: SupportProgressEvent) => void;
};

export type ProbeResult = SupportProbeLike & {
  host: string;
  role: string;
  command: string;
  ok: boolean;
  status: number | null;
  path: string;
  error?: string;
};

type SupportManifest = {
  createdAt: string;
  invokedOn: string;
  screenshots: ScreenshotMode;
  collectionOptions: Record<string, unknown>;
  probes: ProbeResult[];
  failures: ProbeResult[];
  findings: SupportFinding[];
  health: ReturnType<typeof overallHealth>;
  screenshotsMetadata: ScreenshotMetadata[];
};

type HostCommand = {
  path: string;
  remote: string;
  timeoutMs?: number;
};

const DEFAULT_HOSTS = [
  { host: "xps", role: "standalone" },
  { host: "plantlab", role: "coordinator" },
  { host: "greenhouse-zero", role: "greenhouse-node" },
  { host: "bokchoy", role: "camera-node" },
] as const;

export async function collectSupportBundle(options: SupportCollectOptions = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = options.outputDir ?? path.join(process.cwd(), "artifacts", "support");
  await mkdir(outputDir, { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "plantlab-support-"));
  const root = path.join(workDir, `plantlab-support-${timestamp}`);
  await mkdir(root, { recursive: true });

  const manifest: SupportManifest = {
    createdAt: new Date().toISOString(),
    invokedOn: os.hostname(),
    screenshots: options.screenshots ?? "none",
    collectionOptions: {
      scope: options.all ? "all" : options.node ? "node" : options.nodes?.length ? "nodes" : options.coordinator ? "coordinator" : "default-coordinator",
      node: options.node ?? null,
      nodes: options.nodes ?? [],
      coordinator: options.coordinator ?? "plantlab",
      includeLogs: options.includeLogs !== false,
      includeHardwareTests: options.includeHardwareTests === true,
    },
    probes: [],
    failures: [],
    findings: [],
    health: "unknown",
    screenshotsMetadata: [],
  };

  try {
    const hosts = selectedHosts(options);
    await collectLocal(root, manifest);
    for (const host of hosts) {
      options.onProgress?.({ type: "target-start", host: host.host, role: host.role });
      const before = manifest.probes.length;
      await collectHost(root, manifest, host.host, host.role, options, isLocalHostAlias(host.host) ? "local-shell" : "ssh");
      const hostProbes = manifest.probes.slice(before);
      options.onProgress?.({ type: "target-done", host: host.host, role: host.role, status: summarizeHostStatus(hostProbes) });
    }
    if ((options.screenshots ?? "none") !== "none") options.onProgress?.({ type: "screenshots-start", mode: options.screenshots ?? "none" });
    const screenshotsBefore = manifest.probes.length;
    const screenshotMetadata = await collectScreenshots(root, manifest, options.screenshots ?? "none", options.coordinator ?? "plantlab", hosts);
    manifest.screenshotsMetadata.push(...screenshotMetadata);
    if ((options.screenshots ?? "none") !== "none") {
      options.onProgress?.({ type: "screenshots-done", ok: manifest.probes.slice(screenshotsBefore).every((probe) => probe.ok) });
    }
    manifest.findings = await findingsForProbes(manifest.probes);
    manifest.failures = manifest.probes.filter((probe) => !probe.ok);
    manifest.health = overallHealth(manifest.findings, manifest.probes);
    await writeHostDiagnosticSummaries(root, manifest);
    const finalManifest = manifestForArchive(root, manifest);
    const summary = buildSummaryMarkdown(finalManifest);
    await writeFile(path.join(root, "summary.md"), summary);
    await writeFile(path.join(root, "README.html"), buildReadmeHtml(summary));
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(finalManifest, null, 2));
    const zipPath = path.join(outputDir, `plantlab-support-${timestamp}.zip`);
    await createZip(root, zipPath);
    const { size } = await stat(zipPath);
    return { zipPath, filename: path.basename(zipPath), size, manifestPath: "manifest.json", manifest: finalManifest };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Succeeded when every probe passed, failed when none did, partial otherwise - one offline host never aborts the whole bundle. */
export function summarizeHostStatus(probes: ProbeResult[]): SupportTargetStatus {
  if (probes.length === 0) return "succeeded";
  const okCount = probes.filter((probe) => probe.ok).length;
  if (okCount === probes.length) return "succeeded";
  if (okCount === 0) return "failed";
  return "partial";
}

export function selectedHosts(options: SupportCollectOptions): Array<{ host: string; role: string }> {
  if (options.all) return [...DEFAULT_HOSTS];
  const nodes = options.nodes?.filter(Boolean) ?? [];
  if (nodes.length > 0) {
    const coordinator = options.coordinator ? [{ host: options.coordinator, role: "coordinator" }] : [];
    const mapped = nodes.map((node) => DEFAULT_HOSTS.find((host) => host.host === node) ?? { host: node, role: "node" });
    // De-duplicate by host in case the coordinator was also listed as a node.
    const byHost = new Map<string, { host: string; role: string }>();
    for (const entry of [...coordinator, ...mapped]) byHost.set(entry.host, entry);
    return [...byHost.values()];
  }
  if (options.node) {
    const known = DEFAULT_HOSTS.find((host) => host.host === options.node);
    return [known ?? { host: options.node, role: "node" }];
  }
  if (options.coordinator) return [{ host: options.coordinator, role: "coordinator" }];
  return [{ host: "plantlab", role: "coordinator" }];
}

async function collectLocal(root: string, manifest: { probes: ProbeResult[] }) {
  const dir = path.join(root, os.hostname());
  await mkdir(dir, { recursive: true });
  const commands = [
    { name: "hostname", command: "hostname", args: [] },
    { name: "git-status", command: "git", args: ["status", "--short", "--branch"] },
    { name: "git-rev", command: "git", args: ["rev-parse", "HEAD"] },
    { name: "node-info", command: "bin/plantlab", args: ["node", "info"] },
  ];
  for (const item of commands) {
    await runProbe(manifest, "local", "invoker", item.command, item.args, path.join(dir, `${item.name}.txt`));
  }
}

async function collectHost(
  root: string,
  manifest: { probes: ProbeResult[] },
  host: string,
  role: string,
  options: SupportCollectOptions,
  runner: "ssh" | "local-shell" = "ssh",
) {
  const dir = path.join(root, host);
  await mkdir(dir, { recursive: true });
  const commands = hostCommands(host, role, { includeLogs: options.includeLogs !== false, includeHardwareTests: options.includeHardwareTests === true });
  for (const item of commands) {
    if (runner === "local-shell") await runProbe(manifest, host, role, "bash", ["-lc", item.remote], path.join(dir, item.path), item.timeoutMs);
    else await runProbe(manifest, host, role, "ssh", [host, item.remote], path.join(dir, item.path), item.timeoutMs);
  }
}

function hostCommands(host: string, role: string, opts: { includeLogs: boolean; includeHardwareTests: boolean }): HostCommand[] {
  const common: HostCommand[] = [
    { path: "system/hostname.txt", remote: "hostname; date -Is; timedatectl 2>/dev/null | sed -n '1,8p'; df -h ." },
    { path: "system/git.txt", remote: "cd ~/projects/plantlab 2>/dev/null || cd ~/plantlab 2>/dev/null || cd /home/andy/projects/plantlab 2>/dev/null || exit 0; git status --short --branch; git rev-parse HEAD" },
  ];
  if (role === "coordinator") {
    return [
      ...common,
      { path: "services/plantlab-web.txt", remote: "systemctl --user status plantlab-web.service --no-pager -l 2>&1 | tail -120" },
      { path: "services/plantlab-camera.txt", remote: "systemctl --user status plantlab-camera.service --no-pager -l 2>&1 | tail -120" },
      { path: "api/node-info.json", remote: "curl -fsS http://127.0.0.1:3000/api/node-info 2>&1" },
      { path: "api/health.json", remote: "curl -fsS http://127.0.0.1:3000/api/health 2>&1" },
      { path: "api/service-status.json", remote: "curl -fsS http://127.0.0.1:3000/api/service-status 2>&1" },
      { path: "api/nodes-summary.json", remote: "curl -fsS http://127.0.0.1:3000/api/nodes/summary 2>&1" },
      { path: "api/hardware-cameras.json", remote: "curl -fsS http://127.0.0.1:3000/api/hardware/cameras 2>&1" },
      { path: "api/hardware-sensors.json", remote: "curl -fsS http://127.0.0.1:3000/api/hardware/sensors 2>&1" },
      { path: "api/capture-sources.json", remote: "curl -fsS http://127.0.0.1:3000/api/capture-sources 2>&1" },
      { path: "api/projects.json", remote: "curl -fsS http://127.0.0.1:3000/api/projects 2>&1" },
      { path: "database/summary.json", remote: databaseSummaryCommand() },
      { path: "capture/queues.json", remote: captureQueueSummaryCommand() },
      { path: "scheduler/summary.json", remote: schedulerSummaryCommand() },
      { path: "power/summary.json", remote: powerSummaryCommand() },
      { path: "database/migrate-status.txt", remote: "cd /home/andy/projects/plantlab && pnpm prisma migrate status 2>&1" },
      ...(opts.includeLogs
        ? ([
            { path: "logs/web.txt", remote: "journalctl --user -u plantlab-web.service -n 200 --no-pager 2>&1" },
            { path: "logs/camera.txt", remote: "journalctl --user -u plantlab-camera.service -n 200 --no-pager 2>&1" },
          ] as HostCommand[])
        : []),
    ];
  }
  if (role === "standalone") {
    return [
      ...common,
      { path: "services/plantlab-web.txt", remote: "systemctl --user status plantlab-web.service --no-pager -l 2>&1 | tail -120" },
      { path: "services/plantlab-camera.txt", remote: "systemctl --user status plantlab-camera.service --no-pager -l 2>&1 | tail -120" },
      { path: "api/node-info.json", remote: "curl -fsS http://127.0.0.1:3000/api/node-info 2>&1" },
      { path: "api/health.json", remote: "curl -fsS http://127.0.0.1:3000/api/health 2>&1" },
      { path: "api/nodes-summary.json", remote: "curl -fsS http://127.0.0.1:3000/api/nodes/summary 2>&1" },
      { path: "api/hardware-cameras.json", remote: "curl -fsS http://127.0.0.1:3000/api/hardware/cameras 2>&1" },
      { path: "api/hardware-sensors.json", remote: "curl -fsS http://127.0.0.1:3000/api/hardware/sensors 2>&1" },
      { path: "api/capture-sources.json", remote: "curl -fsS http://127.0.0.1:3000/api/capture-sources 2>&1" },
      { path: "api/projects.json", remote: "curl -fsS http://127.0.0.1:3000/api/projects 2>&1" },
      { path: "database/summary.json", remote: databaseSummaryCommand() },
      { path: "capture/queues.json", remote: captureQueueSummaryCommand() },
      { path: "scheduler/summary.json", remote: schedulerSummaryCommand() },
      { path: "power/summary.json", remote: powerSummaryCommand() },
      ...(opts.includeLogs
        ? ([
            { path: "logs/web.txt", remote: "journalctl --user -u plantlab-web.service -n 200 --no-pager 2>&1" },
            { path: "logs/camera.txt", remote: "journalctl --user -u plantlab-camera.service -n 200 --no-pager 2>&1" },
          ] as HostCommand[])
        : []),
    ];
  }
  if (host === "greenhouse-zero") {
    return [
      ...common,
      { path: "doctor/edge-doctor.txt", remote: "bash -lc 'plantlab-edge doctor' 2>&1" },
      { path: "config/effective.json", remote: "bash -lc 'plantlab-edge config show --json' 2>&1" },
      { path: "cameras/inventory.json", remote: "bash -lc 'cat ~/.local/state/plantlab-edge-agent/camera-inventory-cache.json' 2>&1" },
      { path: "cameras/recent-captures.txt", remote: "bash -lc 'find ~/.local/state/plantlab-edge-agent ~/.local/share/plantlab-edge-agent -maxdepth 3 -type f \\( -name \"*capture*\" -o -name \"*camera*\" \\) -printf \"%TY-%Tm-%Td %TH:%TM %p\\n\" 2>/dev/null | sort | tail -80' 2>&1" },
      { path: "sensors/health.txt", remote: "bash -lc 'find ~/.local/state/plantlab-edge-agent ~/.local/share/plantlab-edge-agent -maxdepth 3 -type f \\( -name \"*sensor*\" -o -name \"*diagnostic*\" \\) -printf \"%TY-%Tm-%Td %TH:%TM %p\\n\" 2>/dev/null | sort | tail -80' 2>&1" },
      { path: "power/status.txt", remote: "bash -lc 'plantlab-edge power status' 2>&1", timeoutMs: 45_000 },
      { path: "services/edge-agent.txt", remote: "systemctl --user status plantlab-edge-agent.service --no-pager -l 2>&1 | tail -160" },
      // Intrusive per-sensor hardware read - only when explicitly opted in.
      ...(opts.includeHardwareTests ? ([{ path: "sensors/hardware.txt", remote: "bash -lc 'plantlab-edge doctor --hardware --attempts 1 --interval 0.1' 2>&1" }] as HostCommand[]) : []),
      ...(opts.includeLogs ? ([{ path: "logs/edge-agent.txt", remote: "journalctl --user -u plantlab-edge-agent.service -n 200 --no-pager 2>&1" }] as HostCommand[]) : []),
    ];
  }
  return [
    ...common,
    { path: "doctor/agent-service.txt", remote: "systemctl --user status plantlab-agent.service --no-pager -l 2>&1 | tail -160" },
    { path: "cameras/v4l2.txt", remote: "ls -l /dev/video* /dev/v4l/by-id /dev/v4l/by-path 2>&1; v4l2-ctl --list-devices 2>&1" },
    { path: "cameras/recent-captures.txt", remote: "find ~/.local/state/plantlab-edge-agent ~/.local/share/plantlab-edge-agent -maxdepth 3 -type f \\( -name '*capture*' -o -name '*camera*' \\) -printf '%TY-%Tm-%Td %TH:%TM %p\\n' 2>/dev/null | sort | tail -80" },
    ...(opts.includeLogs ? ([{ path: "logs/agent.txt", remote: "journalctl --user -u plantlab-agent.service -n 200 --no-pager 2>&1" }] as HostCommand[]) : []),
  ];
}

async function runProbe(
  manifest: { probes: ProbeResult[] },
  host: string,
  role: string,
  command: string,
  args: string[],
  outputPath: string,
  timeoutMs = 20_000,
) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await execFileResult(command, args, timeoutMs);
  const redacted = redact(`${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ""}`);
  await writeFile(outputPath, redacted);
  manifest.probes.push({ host, role, command: [command, ...args].join(" "), ok: result.status === 0, status: result.status, path: outputPath, error: result.status === 0 ? undefined : result.stderr.slice(0, 500) });
}

async function collectScreenshots(
  root: string,
  manifest: { probes: ProbeResult[] },
  mode: ScreenshotMode,
  coordinatorHost: string,
  hosts: Array<{ host: string; role: string }>,
): Promise<ScreenshotMetadata[]> {
  const dir = path.join(root, coordinatorHost, "screenshots");
  await mkdir(dir, { recursive: true });
  if (mode === "none") {
    await writeFile(path.join(dir, "README.txt"), "Screenshot collection disabled.\n");
    return [];
  }
  if (mode === "fixture") {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "plantlab-screenshots-fixture-"));
    // `next dev` rewrites next-env.d.ts and reformats tsconfig.json in the
    // project root on startup. Snapshot the exact pre-run content and restore
    // that content afterwards so a support bundle never discards unrelated
    // user edits in a dirty worktree.
    const port = await findFreePort();
    const restoreSnapshots = await snapshotFiles(["next-env.d.ts", "tsconfig.json"]);
    try {
      const { fixtureDb, env } = buildFixtureScreenshotEnv(fixtureRoot, port);
      await mkdir(path.dirname(fixtureDb), { recursive: true });
      const migrate = await execFileResult("pnpm", ["prisma", "migrate", "deploy"], 120_000, process.cwd(), env);
      await writeFile(path.join(dir, "fixture-migrate.txt"), redact(`${migrate.stdout}\n${migrate.stderr}`));
      manifest.probes.push({ host: "local", role: "screenshots", command: "fixture prisma migrate deploy", ok: migrate.status === 0, status: migrate.status, path: path.join(dir, "fixture-migrate.txt") });
      if (migrate.status !== 0) return [];

      // Clear any prior (possibly live-readonly) screenshots so only this
      // fixture run's images get bundled, then capture the small support
      // fixture pass (homepage + node overview). It exercises the isolated
      // fixture homepage node link this bundle exists to verify while
      // compiling only two routes, so it stays well inside the timeout even
      // on the coordinator (which shares CPU with the live services). The
      // full desktop/laptop/mobile suite lives in tests/screenshots.spec.ts.
      await rm(path.join(process.cwd(), "artifacts", "screenshots"), { recursive: true, force: true }).catch(() => undefined);
      // Retry once: the fixture `next dev` server occasionally throws a
      // first-compile "Expected clientReferenceManifest to be defined"
      // invariant on an RSC route under the coordinator's shared CPU, which a
      // recompile clears. The retry keeps the isolated fixture pass reliable
      // without touching any live data.
      const result = await execFileResult(
        "pnpm",
        ["exec", "playwright", "test", "--retries=1", "tests/support-fixture-screenshots.spec.ts"],
        300_000,
        process.cwd(),
        env,
      );
      await writeFile(path.join(dir, "fixture-run.txt"), redact(`${result.stdout}\n${result.stderr}`));
      manifest.probes.push({ host: "local", role: "screenshots", command: "pnpm screenshots (fixture, node surfaces)", ok: result.status === 0, status: result.status, path: path.join(dir, "fixture-run.txt") });
      await copyIfExists(path.join(process.cwd(), "artifacts", "screenshots"), path.join(dir, "artifacts"));
      return await readScreenshotMetadata(path.join(dir, "artifacts"));
    } finally {
      // Tear down the fixture `next dev` server: kill its parent (matched
      // precisely by the --port argument) and the render worker holding the
      // fixture port (fuser targets exactly that random free port — never the
      // live server on 3000). A short settle follows so the worker is gone
      // before the restore.
      await execFileResult(
        "bash",
        ["-c", `pkill -9 -f 'next dev --hostname 127.0.0.1 --port ${port}' 2>/dev/null; fuser -k -9 ${port}/tcp 2>/dev/null; sleep 2; true`],
        15_000,
      ).catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
      const restore = await restoreFiles(restoreSnapshots).catch((error) => ({ ok: false, error: String(error) }));
      const after = await execFileResult("git", ["status", "--short"], 15_000).catch((error) => ({ stdout: "", stderr: String(error), status: -1 }));
      await writeFile(
        path.join(dir, "fixture-cleanup.txt"),
        redact(`restore snapshots: ${JSON.stringify(restore)}\ngit status --short after:\n${after.stdout || "(clean)"}\n${after.stderr ? `stderr:\n${after.stderr}\n` : ""}`),
      ).catch(() => undefined);
    }
    return [];
  }
  const metadata: ScreenshotMetadata[] = [];
  if (hosts.some((host) => host.host === coordinatorHost || host.role === "coordinator")) {
    metadata.push(...(await collectLiveReadonlyScreenshotsForHost(root, manifest, coordinatorHost, "coordinator", "ssh")));
  }
  for (const host of hosts.filter((item) => item.role === "standalone" && isLocalHostAlias(item.host))) {
    metadata.push(...(await collectLiveReadonlyScreenshotsForHost(root, manifest, host.host, host.role, "local-shell")));
  }
  return metadata;
}

async function collectLiveReadonlyScreenshotsForHost(
  root: string,
  manifest: { probes: ProbeResult[] },
  host: string,
  role: string,
  runner: "ssh" | "local-shell",
): Promise<ScreenshotMetadata[]> {
  const dir = path.join(root, host, "screenshots");
  await mkdir(dir, { recursive: true });
  const routes = await discoverLiveScreenshotRoutes(host, runner);
  await writeJson(path.join(dir, "discovered-routes.json"), { host, role, routes });

  if (runner === "local-shell") {
    const routeManifest = path.join(process.cwd(), "artifacts", "support-screenshot-routes.json");
    await writeScreenshotRouteManifest(routeManifest, routes);
    const result = await execFileResult(
      "bash",
      [
        "-lc",
        "rm -rf artifacts/screenshots && mkdir -p artifacts/screenshots && PLANTLAB_SCREENSHOTS_LIVE_READONLY=1 PLANTLAB_SUPPORT_SCREENSHOT_ROUTES_JSON=artifacts/support-screenshot-routes.json PLAYWRIGHT_REUSE_EXISTING_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/live-readonly-screenshots.spec.ts",
      ],
      240_000,
    );
    await writeFile(path.join(dir, "live-readonly-run.txt"), redact(`${result.stdout}\n${result.stderr}`));
    manifest.probes.push({ host, role: "screenshots", command: "pnpm screenshots live-readonly", ok: result.status === 0, status: result.status, path: path.join(dir, "live-readonly-run.txt") });
    await copyIfExists(path.join(process.cwd(), "artifacts", "screenshots"), path.join(dir, "artifacts"));
    return await readScreenshotMetadata(path.join(dir, "artifacts"));
  }

  const routeJson = JSON.stringify({ routes }).replace(/'/g, "'\\''");
  const prepare = await execFileResult(
    "ssh",
    [
      host,
      `cd /home/andy/projects/plantlab && mkdir -p artifacts && printf '%s\n' '${routeJson}' > artifacts/support-screenshot-routes.json`,
    ],
    30_000,
  );
  await writeFile(path.join(dir, "live-readonly-routes-copy.txt"), redact(`${prepare.stdout}\n${prepare.stderr}`));
  manifest.probes.push({ host, role: "screenshots", command: "copy live-readonly screenshot route manifest", ok: prepare.status === 0, status: prepare.status, path: path.join(dir, "live-readonly-routes-copy.txt") });

  const result = await execFileResult(
    "ssh",
    [
      host,
      "cd /home/andy/projects/plantlab && rm -rf artifacts/screenshots && mkdir -p artifacts/screenshots && PLANTLAB_SCREENSHOTS_LIVE_READONLY=1 PLANTLAB_SUPPORT_SCREENSHOT_ROUTES_JSON=artifacts/support-screenshot-routes.json PLAYWRIGHT_REUSE_EXISTING_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test tests/live-readonly-screenshots.spec.ts",
    ],
    240_000,
  );
  await writeFile(path.join(dir, "live-readonly-run.txt"), redact(`${result.stdout}\n${result.stderr}`));
  manifest.probes.push({ host, role: "screenshots", command: "pnpm screenshots live-readonly", ok: result.status === 0, status: result.status, path: path.join(dir, "live-readonly-run.txt") });
  const copyResult = await execFileResult("scp", ["-r", `${host}:/home/andy/projects/plantlab/artifacts/screenshots`, path.join(dir, "artifacts")], 120_000);
  await writeFile(path.join(dir, "live-readonly-copy.txt"), redact(`${copyResult.stdout}\n${copyResult.stderr}`));
  manifest.probes.push({ host, role: "screenshots", command: "copy live-readonly screenshots", ok: copyResult.status === 0, status: copyResult.status, path: path.join(dir, "live-readonly-copy.txt") });
  return await readScreenshotMetadata(path.join(dir, "artifacts"));
}

async function discoverLiveScreenshotRoutes(host: string, runner: "ssh" | "local-shell"): Promise<SupportScreenshotRoute[]> {
  const snapshot: SupportScreenshotDiscoverySnapshot = { host };
  const [nodes, projects, sensors, cameras, sources, photos] = await Promise.all([
    fetchLocalJson(host, runner, "/api/nodes/summary"),
    fetchLocalJson(host, runner, "/api/projects"),
    fetchLocalJson(host, runner, "/api/hardware/sensors"),
    fetchLocalJson(host, runner, "/api/hardware/cameras"),
    fetchLocalJson(host, runner, "/api/capture-sources"),
    fetchLocalJson(host, runner, "/api/photos"),
  ]);

  const nodeRows = asArray((nodes as { nodes?: unknown[] } | null)?.nodes);
  const sensorsByNode = new Map<string, Array<{ key: string }>>();
  for (const sensor of asArray((sensors as { sensors?: unknown[] } | null)?.sensors)) {
    const item = sensor as { key?: unknown; node?: { name?: unknown } };
    const nodeName = typeof item.node?.name === "string" ? item.node.name : null;
    const key = typeof item.key === "string" ? item.key : null;
    if (!nodeName || !key) continue;
    sensorsByNode.set(nodeName, [...(sensorsByNode.get(nodeName) ?? []), { key }]);
  }
  const camerasByNode = new Map<string, Array<{ id: string }>>();
  for (const camera of asArray((cameras as { cameras?: unknown[] } | null)?.cameras)) {
    const item = camera as { id?: unknown; node?: { name?: unknown } };
    const nodeName = typeof item.node?.name === "string" ? item.node.name : null;
    const id = typeof item.id === "string" ? item.id : null;
    if (!nodeName || !id) continue;
    camerasByNode.set(nodeName, [...(camerasByNode.get(nodeName) ?? []), { id }]);
  }

  snapshot.nodes = nodeRows
    .map((node) => {
      const item = node as { name?: unknown };
      return typeof item.name === "string"
        ? { name: item.name, sensors: sensorsByNode.get(item.name) ?? [], cameras: camerasByNode.get(item.name) ?? [] }
        : null;
    })
    .filter((node): node is { name: string; sensors: Array<{ key: string }>; cameras: Array<{ id: string }> } => node !== null);

  const photoRows = asArray(photos);
  const photoByProject = new Map<string, string>();
  for (const photo of photoRows) {
    const item = photo as { id?: unknown; projectId?: unknown };
    if (typeof item.projectId === "string" && typeof item.id === "string" && !photoByProject.has(item.projectId)) photoByProject.set(item.projectId, item.id);
  }
  snapshot.projects = asArray(projects)
    .map((project) => {
      const item = project as { id?: unknown; name?: unknown };
      return typeof item.id === "string" ? { id: item.id, name: typeof item.name === "string" ? item.name : null, photoId: photoByProject.get(item.id) ?? null } : null;
    })
    .filter((project): project is { id: string; name: string | null; photoId: string | null } => project !== null);
  snapshot.captureSources = asArray((sources as { sources?: unknown[] } | null)?.sources)
    .map((source) => {
      const item = source as { id?: unknown; name?: unknown };
      return typeof item.id === "string" ? { id: item.id, name: typeof item.name === "string" ? item.name : null } : null;
    })
    .filter((source): source is { id: string; name: string | null } => source !== null);
  snapshot.photos = photoRows
    .slice(0, 1)
    .map((photo) => {
      const item = photo as { id?: unknown };
      return typeof item.id === "string" ? { id: item.id } : null;
    })
    .filter((photo): photo is { id: string } => photo !== null);

  return discoverScreenshotRoutes(snapshot);
}

async function fetchLocalJson(host: string, runner: "ssh" | "local-shell", route: string): Promise<unknown | null> {
  const remote = `curl -fsS http://127.0.0.1:3000${route} 2>/dev/null`;
  const result = runner === "local-shell" ? await execFileResult("bash", ["-lc", remote], 20_000) : await execFileResult("ssh", [host, remote], 20_000);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function readScreenshotMetadata(artifactsDir: string): Promise<ScreenshotMetadata[]> {
  try {
    const raw = await readFile(path.join(artifactsDir, "metadata.json"), "utf8");
    const parsed = JSON.parse(raw) as { screenshots?: ScreenshotMetadata[] };
    return Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
  } catch {
    return [];
  }
}

async function snapshotFiles(files: string[]) {
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await readFile(path.join(process.cwd(), file), "utf8") };
      } catch {
        return { file, content: null };
      }
    }),
  );
}

async function restoreFiles(snapshots: Array<{ file: string; content: string | null }>) {
  for (const snapshot of snapshots) {
    const filePath = path.join(process.cwd(), snapshot.file);
    if (snapshot.content === null) await rm(filePath, { force: true });
    else await writeFile(filePath, snapshot.content);
  }
  return { ok: true, files: snapshots.map((snapshot) => snapshot.file) };
}

async function writeHostDiagnosticSummaries(root: string, manifest: SupportManifest) {
  const hosts = new Map<string, { role: string; probes: ProbeResult[] }>();
  for (const probe of manifest.probes) {
    const existing = hosts.get(probe.host);
    if (existing) existing.probes.push(probe);
    else hosts.set(probe.host, { role: probe.role, probes: [probe] });
  }

  for (const [host, { role, probes }] of hosts.entries()) {
    const dir = path.join(root, host);
    await mkdir(dir, { recursive: true });
    const archiveProbes = probes.map((probe) => normalizeEvidencePath(root, probe) as ProbeResult);
    const archiveFindings = manifest.findings
      .filter((finding) => finding.host === host)
      .map((finding) => ({
        ...finding,
        evidencePath: finding.evidencePath ? path.relative(root, finding.evidencePath) || finding.evidencePath : undefined,
      }));
    const summary = hostHealthSummary(host, role, archiveProbes, archiveFindings);
    await writeJson(path.join(dir, "health-summary.json"), summary);
    await writeJson(path.join(dir, "services.json"), probeSummary(archiveProbes, "services/"));
    await writeJson(path.join(dir, "git.json"), probeSummary(archiveProbes, "system/git"));
    await writeJson(path.join(dir, "recent-errors.json"), {
      findings: archiveFindings,
      failedProbes: archiveProbes.filter((probe) => !probe.ok),
    });
    await writeJson(path.join(dir, "camera-summary.json"), probeSummary(archiveProbes, "cameras/", "api/hardware-cameras", "capture/"));
    await writeJson(path.join(dir, "sensor-summary.json"), probeSummary(archiveProbes, "sensors/", "api/hardware-sensors"));
    await writeJson(path.join(dir, "capture-summary.json"), probeSummary(archiveProbes, "capture/", "api/capture-sources"));
    await writeJson(path.join(dir, "scheduler-summary.json"), probeSummary(archiveProbes, "scheduler/"));
    await writeJson(path.join(dir, "storage-summary.json"), probeSummary(archiveProbes, "system/hostname", "database/summary"));
    await writeJson(path.join(dir, "configuration-summary.json"), probeSummary(archiveProbes, "config/", "api/node-info"));
    await writeJson(path.join(dir, "api-summary.json"), probeSummary(archiveProbes, "api/"));
  }

  if (manifest.screenshotsMetadata.length > 0) {
    await writeJson(path.join(root, "screenshots-summary.json"), summarizeScreenshotMetadata(manifest.screenshotsMetadata));
  }
}

function probeSummary(probes: ProbeResult[], ...pathIncludes: string[]) {
  const filtered = probes.filter((probe) => pathIncludes.some((needle) => probe.path.includes(needle)));
  return {
    total: filtered.length,
    passed: filtered.filter((probe) => probe.ok).length,
    failed: filtered.filter((probe) => !probe.ok).length,
    probes: filtered.map((probe) => ({ command: probe.command, ok: probe.ok, status: probe.status, path: probe.path, error: probe.error })),
  };
}

function manifestForArchive(root: string, manifest: SupportManifest): SupportManifest {
  const probes = manifest.probes.map((probe) => normalizeEvidencePath(root, probe) as ProbeResult);
  return {
    ...manifest,
    probes,
    failures: probes.filter((probe) => !probe.ok),
    findings: manifest.findings.map((finding) => ({
      ...finding,
      evidencePath: finding.evidencePath ? path.relative(root, finding.evidencePath) || finding.evidencePath : undefined,
    })),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isLocalHostAlias(host: string) {
  return host === os.hostname() || host === "localhost" || host === "127.0.0.1";
}

function databaseSummaryCommand() {
  return `python3 - <<'PY'
import glob, json, os, sqlite3
paths = []
url = os.environ.get("DATABASE_URL")
if url and url.startswith("file:"):
    paths.append(url[5:])
paths.extend([
    "/home/andy/projects/plantlab/prisma/plantlab.db",
    "/home/andy/projects/plantlab/data/plantlab.db",
    os.path.expanduser("~/.local/share/plantlab/plantlab.db"),
])
seen = []
for p in paths:
    p = os.path.abspath(os.path.expanduser(p))
    if p not in seen:
        seen.append(p)
summary = {"candidates": [], "selected": None, "tables": {}, "rowCounts": {}}
for p in seen:
    exists = os.path.exists(p)
    summary["candidates"].append({"path": p, "exists": exists})
    if not exists or summary["selected"]:
        continue
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]
        summary["selected"] = p
        summary["tables"] = {"count": len(tables), "names": tables}
        for name in tables:
            if name.startswith("_"):
                continue
            try:
                summary["rowCounts"][name] = con.execute(f'select count(*) from "{name}"').fetchone()[0]
            except Exception as exc:
                summary["rowCounts"][name] = {"error": str(exc)}
        con.close()
    except Exception as exc:
        summary["candidates"][-1]["error"] = str(exc)
print(json.dumps(summary, indent=2, sort_keys=True))
PY`;
}

function captureQueueSummaryCommand() {
  return sqliteSummaryCommand({
    AgentCaptureJob: "select status, count(*) as count from AgentCaptureJob group by status",
    SourceCapture: "select validationStatus, count(*) as count from SourceCapture group by validationStatus",
    SourceCaptureOccurrence: "select status, skipReason, count(*) as count from SourceCaptureOccurrence group by status, skipReason",
    ProjectCaptureSample: "select status, count(*) as count from ProjectCaptureSample group by status",
  });
}

function schedulerSummaryCommand() {
  return sqliteSummaryCommand({
    CaptureSource: "select id, name, scheduleEnabled, intervalMinutes, timeZone, captureWindowEnabled, nextCaptureAt, retiredAt from CaptureSource order by name limit 80",
    PowerSchedule: "select id, nodeId, outletId, enabled, timeZone, nextRunAt from PowerSchedule order by nextRunAt limit 80",
  });
}

function powerSummaryCommand() {
  return sqliteSummaryCommand({
    NodeOutlet: "select id, nodeId, outletKey, label, enabled, retiredAt, observedState, observedAt from NodeOutlet order by outletKey",
    PowerCommand: "select status, count(*) as count from PowerCommand group by status",
    PowerStateEvent: "select outletKey, observedState, max(observedAt) as latestObservedAt, count(*) as eventCount from PowerStateEvent group by outletKey, observedState",
  });
}

function sqliteSummaryCommand(queries: Record<string, string>) {
  const encoded = Buffer.from(JSON.stringify(queries), "utf8").toString("base64");
  return `PLANTLAB_SUPPORT_QUERIES=${encoded} python3 - <<'PY'
import base64, glob, json, os, sqlite3
queries = json.loads(base64.b64decode(os.environ["PLANTLAB_SUPPORT_QUERIES"]).decode())
paths = []
url = os.environ.get("DATABASE_URL")
if url and url.startswith("file:"):
    paths.append(url[5:])
paths.extend([
    "/home/andy/projects/plantlab/prisma/plantlab.db",
    "/home/andy/projects/plantlab/data/plantlab.db",
    os.path.expanduser("~/.local/share/plantlab/plantlab.db"),
])
db = next((os.path.abspath(os.path.expanduser(p)) for p in paths if os.path.exists(os.path.abspath(os.path.expanduser(p)))), None)
out = {"database": db, "queries": {}}
if db:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    for table, query in queries.items():
        if table not in tables:
            out["queries"][table] = {"skipped": "table not present"}
            continue
        try:
            out["queries"][table] = [dict(row) for row in con.execute(query).fetchmany(200)]
        except Exception as exc:
            out["queries"][table] = {"error": str(exc)}
    con.close()
print(json.dumps(out, indent=2, sort_keys=True))
PY`;
}

/**
 * Builds the isolated environment for a fixture-mode screenshot run: a
 * temporary, absolute SQLite database under the OS temp directory (never a
 * relative or repo-local path, and never the live coordinator DB), plus the
 * PLANTLAB_SCREENSHOTS_FIXTURE_ONLY flag the mutating fixture helpers
 * require (see assertFixtureDatabase in tests/helpers/devData.ts). Extracted
 * as a pure function so the isolation contract is directly unit-tested.
 */
export function buildFixtureScreenshotEnv(fixtureRoot: string, port: number): { fixtureDb: string; env: NodeJS.ProcessEnv } {
  if (!path.isAbsolute(fixtureRoot)) {
    throw new Error("Fixture screenshot root must be an absolute path.");
  }
  const fixtureDb = path.join(fixtureRoot, "prisma", "plantlab-test-playwright.db");
  return {
    fixtureDb,
    env: {
      ...process.env,
      DATABASE_URL: `file:${fixtureDb}`,
      PLANTLAB_ROOT_DIR: fixtureRoot,
      PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: "1",
      // Start `next dev` without a prior build (the slow step) ...
      PLANTLAB_SKIP_BUILD: "1",
      // ... and give that dev server its OWN build directory under the
      // isolated fixture root, so it never rewrites or clears the live
      // deployment's .next (which would break `next start` on its next
      // restart). Critical isolation boundary - see next.config.ts.
      PLANTLAB_NEXT_DIST_DIR: path.join(fixtureRoot, ".next-fixture"),
      // A fixture run must never reuse an already-running (possibly live)
      // server, and must never claim to be a live-readonly run.
      PLANTLAB_SCREENSHOTS_LIVE_READONLY: "0",
      PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
      PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
      PORT: String(port),
    },
  };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a free localhost port."));
      });
    });
  });
}

async function copyIfExists(from: string, to: string) {
  try {
    await stat(from);
    await cp(from, to, { recursive: true });
  } catch {
    await mkdir(to, { recursive: true });
    await writeFile(path.join(to, "README.txt"), "No screenshot artifacts were present.\n");
  }
}

async function createZip(sourceDir: string, zipPath: string) {
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  let result = await execFileResult("zip", ["-qr", zipPath, name], 120_000, parent);
  if (result.status === 0) return;
  const files = await listFiles(sourceDir);
  result = await execFileResult("python3", ["-m", "zipfile", "-c", zipPath, ...files], 120_000, sourceDir);
  if (result.status !== 0) throw new Error(`Could not create support ZIP: ${result.stderr || result.stdout}`);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return (await listFiles(full)).map((item) => path.join(entry.name, item));
      return entry.name;
    }),
  );
  return files.flat();
}

function execFileResult(command: string, args: string[], timeoutMs: number, cwd = process.cwd(), env = process.env) {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, cwd, env }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const status = typeof code === "number" ? code : error ? 124 : 0;
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), status });
    });
  });
}

export function redact(input: string): string {
  return input
    .replace(/(PLANTLAB_NODE_CREDENTIAL=)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/("(?:token|credential|password|secret|kasaPassword|KASA_PASSWORD)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/((?:token|credential|password|secret|KASA_PASSWORD|KASA_USERNAME)\s*=\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}
