import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportCollect.ts is server-only operational code.");
}

export type ScreenshotMode = "fixture" | "live-readonly" | "none";

export type SupportCollectOptions = {
  node?: string | null;
  coordinator?: string | null;
  all?: boolean;
  screenshots?: ScreenshotMode;
  outputDir?: string;
};

type ProbeResult = {
  host: string;
  role: string;
  command: string;
  ok: boolean;
  status: number | null;
  path: string;
  error?: string;
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

  const manifest: { createdAt: string; invokedOn: string; screenshots: ScreenshotMode; probes: ProbeResult[]; failures: ProbeResult[] } = {
    createdAt: new Date().toISOString(),
    invokedOn: os.hostname(),
    screenshots: options.screenshots ?? "none",
    probes: [],
    failures: [],
  };

  try {
    const hosts = selectedHosts(options);
    await collectLocal(root, manifest);
    for (const host of hosts) {
      if (host.host === os.hostname()) continue;
      await collectHost(root, manifest, host.host, host.role);
    }
    await collectScreenshots(root, manifest, options.screenshots ?? "none", options.coordinator ?? "plantlab");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ ...manifest, failures: manifest.probes.filter((probe) => !probe.ok) }, null, 2));
    const zipPath = path.join(outputDir, `plantlab-support-${timestamp}.zip`);
    await createZip(root, zipPath);
    return { zipPath, manifestPath: path.join(root, "manifest.json"), manifest };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function selectedHosts(options: SupportCollectOptions) {
  if (options.all) return DEFAULT_HOSTS;
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

async function collectHost(root: string, manifest: { probes: ProbeResult[] }, host: string, role: string) {
  const dir = path.join(root, host);
  await mkdir(dir, { recursive: true });
  const commands = hostCommands(host, role);
  for (const item of commands) {
    await runProbe(manifest, host, role, "ssh", [host, item.remote], path.join(dir, item.path), item.timeoutMs);
  }
}

function hostCommands(host: string, role: string): HostCommand[] {
  const common = [
    { path: "system/hostname.txt", remote: "hostname; date -Is; timedatectl 2>/dev/null | sed -n '1,8p'; df -h ." },
    { path: "system/git.txt", remote: "cd ~/projects/plantlab 2>/dev/null || cd ~/plantlab 2>/dev/null || cd /home/andy/projects/plantlab 2>/dev/null || exit 0; git status --short --branch; git rev-parse HEAD" },
  ];
  if (role === "coordinator") {
    return [
      ...common,
      { path: "services/plantlab-web.txt", remote: "systemctl --user status plantlab-web.service --no-pager -l 2>&1 | tail -120" },
      { path: "services/plantlab-camera.txt", remote: "systemctl --user status plantlab-camera.service --no-pager -l 2>&1 | tail -120" },
      { path: "api/node-info.json", remote: "curl -fsS http://127.0.0.1:3000/api/node-info 2>&1" },
      { path: "api/nodes-greenhouse-zero.json", remote: "curl -fsS http://127.0.0.1:3000/api/nodes/greenhouse-zero 2>&1" },
      { path: "database/migrate-status.txt", remote: "cd /home/andy/projects/plantlab && pnpm prisma migrate status 2>&1" },
      { path: "logs/web.txt", remote: "journalctl --user -u plantlab-web.service -n 200 --no-pager 2>&1" },
      { path: "logs/camera.txt", remote: "journalctl --user -u plantlab-camera.service -n 200 --no-pager 2>&1" },
    ];
  }
  if (host === "greenhouse-zero") {
    return [
      ...common,
      { path: "doctor/edge-doctor.txt", remote: "bash -lc 'plantlab-edge doctor' 2>&1" },
      { path: "config/effective.json", remote: "bash -lc 'plantlab-edge config show --json' 2>&1" },
      { path: "sensors/hardware.txt", remote: "bash -lc 'plantlab-edge doctor --hardware --attempts 1 --interval 0.1' 2>&1" },
      { path: "cameras/inventory.json", remote: "bash -lc 'cat ~/.local/state/plantlab-edge-agent/camera-inventory-cache.json' 2>&1" },
      { path: "power/status.txt", remote: "bash -lc 'plantlab-edge power status' 2>&1", timeoutMs: 45_000 },
      { path: "services/edge-agent.txt", remote: "systemctl --user status plantlab-edge-agent.service --no-pager -l 2>&1 | tail -160" },
      { path: "logs/edge-agent.txt", remote: "journalctl --user -u plantlab-edge-agent.service -n 200 --no-pager 2>&1" },
    ];
  }
  return [
    ...common,
    { path: "doctor/agent-service.txt", remote: "systemctl --user status plantlab-agent.service --no-pager -l 2>&1 | tail -160" },
    { path: "cameras/v4l2.txt", remote: "ls -l /dev/video* /dev/v4l/by-id /dev/v4l/by-path 2>&1; v4l2-ctl --list-devices 2>&1" },
    { path: "logs/agent.txt", remote: "journalctl --user -u plantlab-agent.service -n 200 --no-pager 2>&1" },
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

async function collectScreenshots(root: string, manifest: { probes: ProbeResult[] }, mode: ScreenshotMode, coordinatorHost: string) {
  const dir = path.join(root, coordinatorHost, "screenshots");
  await mkdir(dir, { recursive: true });
  if (mode === "none") {
    await writeFile(path.join(dir, "README.txt"), "Screenshot collection disabled.\n");
    return;
  }
  if (mode === "fixture") {
    const result = await execFileResult("pnpm", ["screenshots"], 120_000, process.cwd(), { ...process.env, PLANTLAB_SCREENSHOTS_FIXTURE_ONLY: "1" });
    await writeFile(path.join(dir, "fixture-run.txt"), redact(`${result.stdout}\n${result.stderr}`));
    manifest.probes.push({ host: "local", role: "screenshots", command: "pnpm screenshots", ok: result.status === 0, status: result.status, path: path.join(dir, "fixture-run.txt") });
    await copyIfExists(path.join(process.cwd(), "artifacts", "screenshots"), path.join(dir, "artifacts"));
    return;
  }
  const result = await execFileResult(
    "ssh",
    [
      coordinatorHost,
      "cd /home/andy/projects/plantlab && rm -rf artifacts/screenshots && mkdir -p artifacts/screenshots && PLANTLAB_SCREENSHOTS_LIVE_READONLY=1 pnpm exec playwright test tests/live-readonly-screenshots.spec.ts",
    ],
    120_000,
  );
  await writeFile(path.join(dir, "live-readonly-run.txt"), redact(`${result.stdout}\n${result.stderr}`));
  manifest.probes.push({ host: coordinatorHost, role: "screenshots", command: "pnpm screenshots live-readonly", ok: result.status === 0, status: result.status, path: path.join(dir, "live-readonly-run.txt") });
  const copyResult = await execFileResult("scp", ["-r", `${coordinatorHost}:/home/andy/projects/plantlab/artifacts/screenshots`, path.join(dir, "artifacts")], 120_000);
  await writeFile(path.join(dir, "live-readonly-copy.txt"), redact(`${copyResult.stdout}\n${copyResult.stderr}`));
  manifest.probes.push({ host: coordinatorHost, role: "screenshots", command: "copy live-readonly screenshots", ok: copyResult.status === 0, status: copyResult.status, path: path.join(dir, "live-readonly-copy.txt") });
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
