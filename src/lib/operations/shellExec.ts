// Low-level local/remote command execution primitives shared by
// remoteNode.ts (inspection/diagnostics) and roleConvergence.ts (the
// canonical convergence operation) - kept in one module specifically so
// neither has to import the other, avoiding a circular dependency while
// still sharing exactly one implementation of "run this shell script
// locally" / "run this shell script over SSH".

import { execFile, spawn } from "node:child_process";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/shellExec.ts spawns local/ssh processes and must not run in a browser.");
}

export type CommandResult = { stdout: string; stderr: string; status: number | null };

const HOST_PATTERN = /^[A-Za-z0-9._@:+-]+$/;

export function validateSshHost(host: string): void {
  if (!HOST_PATTERN.test(host) || host.startsWith("-")) {
    throw new Error(`Unsafe SSH host "${host}". Use an alias from ~/.ssh/config without whitespace or shell metacharacters.`);
  }
}

export function runLocalCommand(command: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 15000}ms.`));
    }, options.timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Runs `script` locally via `sh -s` - the same interpreter used for the remote SSH path, so one script text behaves identically either way. */
export async function runLocalShell(script: string, args: string[] = [], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  return runLocalCommand("sh", ["-s", "--", ...args], { input: script, timeoutMs: options.timeoutMs ?? 20_000 });
}

export async function runRemoteShell(
  sshHost: string,
  script: string,
  args: string[] = [],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  validateSshHost(sshHost);
  return runLocalCommand("ssh", [sshHost, "sh", "-s", "--", ...args], {
    input: `${script}\n${options.input ?? ""}`,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
}

export async function resolveSshHost(host: string): Promise<string | null> {
  validateSshHost(host);
  return new Promise((resolve) => {
    execFile("ssh", ["-G", host], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const hostName = stdout
        .toString()
        .split("\n")
        .find((line) => line.toLowerCase().startsWith("hostname "))
        ?.split(/\s+/)
        .slice(1)
        .join(" ");
      resolve(hostName || null);
    });
  });
}
