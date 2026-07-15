// The one operation that owns role-specific state convergence for a
// PlantLab node - local (this machine, via `plantlab install`) or remote
// (another machine, via `plantlab node attach` / `plantlab doctor --fix
// --node`). See ARCHITECTURE.md "Role convergence" and DEPLOYMENT.md
// "Canonical role-convergence design".
//
// It owns: role/coordinator-URL config, the credential file, the spool
// root, systemd unit installation (mask-safe - see systemdUnits.ts),
// expected-service enable/start, inappropriate-service stop/disable, and
// post-convergence verification. Migration is a related but separate
// concern for local coordinator/standalone targets only - see
// migrations.ts - because a remote target in this codebase is always a
// camera-node, which never touches the canonical domain database.
//
// This function is idempotent and safe to re-run: every write is either
// atomic (config, credential, unit files) or naturally idempotent
// (mkdir -p, systemctl enable/disable/unmask). A failed run can always be
// retried with the same inputs.

import path from "node:path";
import { resolveRootDir } from "../paths.server";
import { AgentSpool } from "./agentSpool";
import { type NodeRole, writeNodeConfigRaw, type NodeConfig } from "./config";
import { runLocalShell, runRemoteShell, validateSshHost } from "./shellExec";
import { expectedServicesForRole, inappropriateServicesForRole, SERVICE_UNITS, type PlantLabServiceName } from "./serviceRoles";
import {
  buildUnitConvergenceScript,
  buildUnitContent,
  classifyUnitState,
  isMaskedState,
  parseUnitStatesOutput,
  type PlantLabUnitName,
  type UnitState,
} from "./systemdUnits";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/roleConvergence.ts spawns local/ssh processes and must not run in a browser.");
}

export type ConvergenceTarget =
  | { kind: "local" }
  | { kind: "remote"; sshHost: string; repoPath: string };

export type ConvergeNodeRoleInput = {
  target: ConvergenceTarget;
  role: NodeRole;
  coordinatorUrl?: string | null;
  nodeName?: string | null;
  /** Camera-node only. Defaults to "<home>/.local/state/plantlab-agent" (local) or "/home/<remoteUser>/.local/state/plantlab-agent" (remote) when omitted. */
  spoolRoot?: string | null;
  /** Camera-node only. The raw credential token to write into the agent env file. Omit (undefined) to leave any existing credential file untouched - see "credential reuse" in DEPLOYMENT.md. */
  credential?: string | null;
  /** Enable+start expected units and stop+disable inappropriate ones. False performs every other step (config/credential/unit-file/spool) without touching running services - used for a narrow repair that must not restart an already-healthy service. */
  startServices: boolean;
  /**
   * Local target only. False skips systemd entirely - no unit files
   * written, no `systemctl` invoked at all (not even `daemon-reload`) -
   * for a dev sandbox or CI with no systemd user session, where any
   * systemctl call would fail outright regardless of startServices. Config
   * (and, for camera-node, the spool and credential) are still written.
   * Defaults to true. A remote target always manages systemd - there is no
   * "skip" concept for a real camera node.
   */
  manageSystemd?: boolean;
  /** Override pnpm/npm auto-detection (mainly for tests). */
  runBin?: string | null;
  /** Remote-only: the user whose home directory the default spool root is derived from, when spoolRoot is not given explicitly. */
  remoteUser?: string | null;
  /** Force a restart of the expected units even if already active. Automatically implied whenever a credential is written (see systemdUnits.ts buildUnitConvergenceScript - `enable --now` alone does not restart an already-running unit, so a rotated credential would otherwise never take effect). Set explicitly for any other case that needs a guaranteed restart. */
  forceRestart?: boolean;
};

export type ConvergenceStepStatus = "completed" | "skipped" | "failed";
export type ConvergenceStep = { name: string; status: ConvergenceStepStatus; detail: string };

export type ConvergenceResult = {
  ok: boolean;
  steps: ConvergenceStep[];
  maskCleared: PlantLabUnitName[];
  unitStates: UnitState[];
  configWritten: boolean;
  credentialWritten: boolean;
  spoolPrepared: boolean;
  /** A safe, idempotent command to re-run this exact convergence if it failed partway. */
  retryCommand: string;
};

function unitsForRole(role: NodeRole): { expected: PlantLabUnitName[]; inappropriate: PlantLabUnitName[] } {
  const expectedNames = expectedServicesForRole(role);
  const inappropriateNames = inappropriateServicesForRole(role);
  return {
    expected: expectedNames.map((s: PlantLabServiceName) => SERVICE_UNITS[s]),
    inappropriate: inappropriateNames.map((s: PlantLabServiceName) => SERVICE_UNITS[s]),
  };
}

function defaultSpoolRoot(target: ConvergenceTarget, remoteUser: string | null | undefined): string {
  if (target.kind === "local") {
    return path.join(process.env.HOME ?? "/root", ".local", "state", "plantlab-agent");
  }
  const user = remoteUser || target.sshHost;
  return `/home/${user}/.local/state/plantlab-agent`;
}

async function resolveRunBin(target: ConvergenceTarget, override: string | null | undefined): Promise<string> {
  if (override) return override;
  const script = 'command -v pnpm 2>/dev/null || command -v npm 2>/dev/null || true';
  const result = target.kind === "local" ? await runLocalShell(script) : await runRemoteShell(target.sshHost, script);
  const runBin = result.stdout.trim().split("\n")[0]?.trim();
  if (!runBin) {
    throw new Error(`Neither pnpm nor npm was found on ${target.kind === "local" ? "this machine" : target.sshHost}'s PATH.`);
  }
  return runBin;
}

/**
 * The remote user's actual $HOME, queried directly rather than guessed as
 * `/home/<user>` - a real but narrow fragility that assumption had (not
 * every Linux setup puts home directories under /home/), and asking is a
 * single cheap round trip alongside the existing resolveRunBin() one.
 */
async function resolveRemoteHome(sshHost: string, remoteUser: string | null | undefined): Promise<string> {
  const result = await runRemoteShell(sshHost, 'echo "$HOME"');
  const home = result.stdout.trim().split("\n")[0]?.trim();
  return home || `/home/${remoteUser || sshHost}`;
}

function buildRetryCommand(input: ConvergeNodeRoleInput): string {
  if (input.target.kind === "local") {
    return `plantlab install --role ${input.role}${input.coordinatorUrl ? ` --coordinator-url ${input.coordinatorUrl}` : ""}`;
  }
  return `plantlab node attach ${input.target.sshHost}${input.coordinatorUrl ? ` --coordinator-url ${input.coordinatorUrl}` : ""}`;
}

/**
 * Converges a local or remote target's filesystem/systemd state to match
 * the requested role. See the module doc comment above for exactly what
 * this owns. Callers (plantlab install, plantlab node attach, plantlab
 * doctor --fix) are responsible for anything outside that scope:
 * coordinator-side node/credential registration (nodeCredentials.ts),
 * remote inspection (remoteNode.ts), and domain-database migration for
 * local coordinator/standalone roles (migrations.ts).
 */
export async function convergeNodeRole(input: ConvergeNodeRoleInput): Promise<ConvergenceResult> {
  const steps: ConvergenceStep[] = [];
  const retryCommand = buildRetryCommand(input);

  if (input.target.kind === "remote") {
    try {
      validateSshHost(input.target.sshHost);
    } catch (error) {
      steps.push({ name: "target-validation", status: "failed", detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, steps, maskCleared: [], unitStates: [], configWritten: false, credentialWritten: false, spoolPrepared: false, retryCommand };
    }
  }

  const repoPath = input.target.kind === "local" ? resolveRootDir() : input.target.repoPath;
  const { expected, inappropriate } = unitsForRole(input.role);
  // camera-node and greenhouse-node both run plantlab-agent.service and
  // need the same credential/spool - see serviceRoles.ts.
  const isAgentRole = input.role === "camera-node" || input.role === "greenhouse-node";
  const spoolRoot = isAgentRole ? (input.spoolRoot || defaultSpoolRoot(input.target, input.remoteUser)) : null;

  // Spool directories: created via AgentSpool locally (reuses the real
  // implementation the agent runtime itself uses - see agentSpool.ts) or
  // via plain `mkdir -p` remotely (state.sqlite is created by the agent's
  // own first startup, which this convergence enables+starts below).
  let spoolPrepared = false;
  if (isAgentRole && spoolRoot) {
    try {
      if (input.target.kind === "local") {
        const spool = new AgentSpool(spoolRoot);
        await spool.init();
        spool.close();
      } else {
        const script = `mkdir -p '${spoolRoot.replace(/'/g, "'\\''")}'/spool/pending '${spoolRoot.replace(/'/g, "'\\''")}'/spool/uploading '${spoolRoot.replace(/'/g, "'\\''")}'/spool/acknowledged '${spoolRoot.replace(/'/g, "'\\''")}'/spool/failed '${spoolRoot.replace(/'/g, "'\\''")}'/logs`;
        const result = await runRemoteShell(input.target.sshHost, script);
        if (result.status !== 0) {
          throw new Error(result.stderr.trim() || "Could not create the remote spool directories.");
        }
      }
      spoolPrepared = true;
      steps.push({ name: "spool-directories", status: "completed", detail: `Prepared ${spoolRoot}.` });
    } catch (error) {
      steps.push({ name: "spool-directories", status: "failed", detail: error instanceof Error ? error.message : String(error) });
      return { ok: false, steps, maskCleared: [], unitStates: [], configWritten: false, credentialWritten: false, spoolPrepared: false, retryCommand };
    }
  }

  const config: NodeConfig = {
    formatVersion: 1,
    role: input.role,
    configuredAt: new Date().toISOString(),
    hostname: input.nodeName || (input.target.kind === "remote" ? input.target.sshHost : "localhost"),
    coordinatorUrl: input.coordinatorUrl ?? null,
    nodeName: input.nodeName ?? null,
    spoolRoot: spoolRoot,
  };

  // manageSystemd:false (local only) - write config (and credential, for
  // camera-node) directly via Node, and stop here. No unit files, no
  // systemctl invocation of any kind - not even daemon-reload - so this is
  // safe to run in a sandbox with no systemd user session at all. See the
  // ConvergeNodeRoleInput.manageSystemd doc comment.
  if (input.target.kind === "local" && input.manageSystemd === false) {
    await writeNodeConfigRaw(config);
    steps.push({ name: "config-write", status: "completed", detail: `role=${input.role} written to ${repoPath}/plantlab.config.json.` });

    let credentialWritten = false;
    if (isAgentRole && input.credential) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const envDir = path.dirname(path.join(process.env.HOME ?? "/root", ".config", "plantlab", "agent.env"));
      const envPath = path.join(envDir, "agent.env");
      await mkdir(envDir, { recursive: true, mode: 0o700 });
      await writeFile(envPath, `PLANTLAB_NODE_CREDENTIAL=${input.credential}\n`, { mode: 0o600 });
      credentialWritten = true;
      steps.push({ name: "credential-write", status: "completed", detail: `Credential written to ${envPath} (0600).` });
    }

    steps.push({ name: "systemd-units", status: "skipped", detail: "Skipped (manageSystemd: false) - no systemctl call was made." });
    return {
      ok: steps.every((step) => step.status !== "failed"),
      steps,
      maskCleared: [],
      unitStates: [],
      configWritten: true,
      credentialWritten,
      spoolPrepared,
      retryCommand,
    };
  }

  let runBin: string;
  try {
    runBin = await resolveRunBin(input.target, input.runBin);
    steps.push({ name: "runtime-detection", status: "completed", detail: `Using ${runBin}.` });
  } catch (error) {
    steps.push({ name: "runtime-detection", status: "failed", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, steps, maskCleared: [], unitStates: [], configWritten: false, credentialWritten: false, spoolPrepared, retryCommand };
  }

  // Resolved to a concrete absolute path (not systemd's "%h" specifier) for
  // both targets, matching the existing agent unit convention - see
  // buildAgentServiceUnit() in systemdUnits.ts. For a remote target this is
  // the remote user's *actual* $HOME (queried directly - see
  // resolveRemoteHome()), not a guessed `/home/<user>` path.
  const agentEnvPath =
    input.target.kind === "local"
      ? path.join(process.env.HOME ?? "/root", ".config", "plantlab", "agent.env")
      : path.posix.join(await resolveRemoteHome(input.target.sshHost, input.remoteUser), ".config", "plantlab", "agent.env");

  const install = expected.map((unitName) => ({
    unitName,
    content: buildUnitContent(unitName, { repoPath, runBin, envPath: agentEnvPath, localCameraEnabled: input.role === "standalone" }),
  }));

  const credentialEnv = isAgentRole && input.credential ? { path: agentEnvPath, content: `PLANTLAB_NODE_CREDENTIAL=${input.credential}\n` } : null;

  const script = buildUnitConvergenceScript(
    {
      install,
      stopAndDisable: input.startServices ? inappropriate : [],
      startInstalled: input.startServices,
      configJson: `${JSON.stringify(config, null, 2)}\n`,
      credentialEnv,
      restartInstalled: input.startServices && (Boolean(input.forceRestart) || Boolean(credentialEnv)),
    },
    repoPath,
  );

  const result = input.target.kind === "local" ? await runLocalShell(script) : await runRemoteShell(input.target.sshHost, script);

  const maskCleared = Array.from(result.stdout.matchAll(/^MASK-CLEARED:(.+)$/gm)).map((m) => m[1].trim() as PlantLabUnitName);
  for (const unit of maskCleared) {
    steps.push({ name: `unmask:${unit}`, status: "completed", detail: `${unit} was masked from a previous installation; unmasked.` });
  }

  const statesBlockMatch = result.stdout.match(/UNIT-STATES:\n([\s\S]*)$/);
  const unitStates = statesBlockMatch ? parseUnitStatesOutput(statesBlockMatch[1]) : [];

  if (result.status !== 0) {
    steps.push({
      name: "convergence-script",
      status: "failed",
      detail: (result.stderr.trim() || result.stdout.trim() || "Convergence script failed.").slice(0, 2000),
    });
    return {
      ok: false,
      steps,
      maskCleared,
      unitStates,
      configWritten: false,
      credentialWritten: false,
      spoolPrepared,
      retryCommand,
    };
  }

  steps.push({ name: "config-write", status: "completed", detail: `role=${input.role} written to ${repoPath}/plantlab.config.json.` });
  if (credentialEnv) {
    steps.push({ name: "credential-write", status: "completed", detail: `Credential written to ${credentialEnv.path} (0600).` });
  } else if (isAgentRole) {
    steps.push({ name: "credential-write", status: "skipped", detail: "No new credential provided - existing credential file left untouched." });
  }
  for (const unit of install) {
    steps.push({ name: `unit-install:${unit.unitName}`, status: "completed", detail: `Installed/updated ${unit.unitName}.` });
  }
  if (input.startServices) {
    for (const unit of inappropriate) {
      steps.push({ name: `stop-disable:${unit}`, status: "completed", detail: `Stopped and disabled ${unit} (inappropriate for role ${input.role}).` });
    }
    for (const unit of expected) {
      const state = unitStates.find((s) => s.id === unit);
      const activeOk = state?.activeState === "active";
      steps.push({
        name: `verify:${unit}`,
        status: activeOk ? "completed" : "failed",
        detail: state ? `${unit} is ${classifyUnitState(state)}.` : `${unit} state could not be verified.`,
      });
    }
  }

  const anyMaskedRemaining = unitStates.some((state) => isMaskedState(state));
  const anyVerifyFailed = steps.some((step) => step.name.startsWith("verify:") && step.status === "failed");
  const ok = !anyMaskedRemaining && !anyVerifyFailed && steps.every((step) => step.status !== "failed");

  return {
    ok,
    steps,
    maskCleared,
    unitStates,
    configWritten: true,
    credentialWritten: Boolean(credentialEnv),
    spoolPrepared,
    retryCommand,
  };
}

// Re-exported so a local-only caller (e.g. plantlab install for a
// coordinator/standalone role, which never needs SSH) can write its own
// config through the same atomic path without pulling in the whole
// convergence script machinery when it has no units/credential/spool to
// manage - see install.ts.
export { writeNodeConfigRaw };
