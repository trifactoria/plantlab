// Shared systemd user-unit templates, mask-safe atomic installation, and
// structured state queries - used by both local (plantlab install) and
// remote (plantlab node attach / doctor --fix --node) role convergence.
// See ARCHITECTURE.md "Role convergence" for why this exists as one module
// instead of parallel shell fragments in remoteNode.ts and
// deploy/systemd/install.sh.
//
// Root cause this module fixes (see DEPLOYMENT.md "Systemd mask recovery"):
// writing a unit file via plain shell redirection (`sed ... > "$unit_path"`)
// against a path that is currently a `-> /dev/null` mask symlink succeeds
// silently (exit 0) and writes THROUGH the symlink to /dev/null - the mask
// is never cleared and the "new" unit content is discarded. `mv` (rename(2))
// replaces the directory entry itself instead of following it, which both
// makes the write atomic AND correctly clears a stale mask as a side
// effect - verified empirically against a real systemd --user session.
// This module always writes via mktemp+mv, never `>`, and additionally
// calls `systemctl --user unmask` explicitly first so the mask is detected,
// reported, and cleared through the supported systemd interface rather than
// relying solely on the mv side effect.

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/systemdUnits.ts spawns systemctl and must not run in a browser.");
}

export type PlantLabUnitName = "plantlab-web.service" | "plantlab-camera.service" | "plantlab-agent.service";

export function buildWebServiceUnit(input: { repoPath: string; runBin: string }): string {
  return `[Unit]
Description=PlantLab web application (Next.js production server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.repoPath}
Environment=NODE_ENV=production
Environment=PLANTLAB_ROOT_DIR=${input.repoPath}
Environment=PLANTLAB_LOCAL_CAMERA_ENABLED=1
ExecStart=${input.runBin} run start
Restart=on-failure
RestartSec=5
EnvironmentFile=-${input.repoPath}/.env.local
EnvironmentFile=-%h/.config/plantlab/web.env

[Install]
WantedBy=default.target
`;
}

export function buildCameraServiceUnit(input: { repoPath: string; runBin: string }): string {
  return `[Unit]
Description=PlantLab camera/scheduler service (multi-project capture + shared shelf-camera fan-out)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.repoPath}
Environment=PLANTLAB_ROOT_DIR=${input.repoPath}
ExecStart=${input.runBin} run camera:service
Restart=on-failure
RestartSec=5
EnvironmentFile=-${input.repoPath}/.env.local
EnvironmentFile=-%h/.config/plantlab/camera.env

[Install]
WantedBy=default.target
`;
}

export function buildAgentServiceUnit(input: { repoPath: string; runBin: string; envPath: string }): string {
  return `[Unit]
Description=PlantLab camera-node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.repoPath}
Environment=NODE_ENV=production
Environment=PLANTLAB_ROOT_DIR=${input.repoPath}
EnvironmentFile=${input.envPath}
ExecStart=${input.runBin} run agent:service
SyslogIdentifier=plantlab-agent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function buildUnitContent(unitName: PlantLabUnitName, input: { repoPath: string; runBin: string; envPath?: string }): string {
  if (unitName === "plantlab-web.service") return buildWebServiceUnit(input);
  if (unitName === "plantlab-camera.service") return buildCameraServiceUnit(input);
  return buildAgentServiceUnit({ repoPath: input.repoPath, runBin: input.runBin, envPath: input.envPath ?? "%h/.config/plantlab/agent.env" });
}

export type UnitState = {
  id: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
};

export function isMaskedState(state: Pick<UnitState, "loadState" | "unitFileState">): boolean {
  return state.loadState === "masked" || state.unitFileState === "masked";
}

/** Human classification matching the vocabulary required by the task spec: masked/disabled/enabled/static/not-found/failed/active/inactive. */
export function classifyUnitState(state: UnitState): string {
  if (isMaskedState(state)) return "masked";
  if (state.loadState === "not-found") return "not-found";
  if (state.activeState === "failed") return "failed";
  if (state.activeState === "active") return "active";
  if (state.unitFileState === "enabled" || state.unitFileState === "enabled-runtime") return "enabled";
  if (state.unitFileState === "static") return "static";
  if (state.unitFileState === "disabled") return "disabled";
  return state.activeState || "inactive";
}

/** Shell fragment (POSIX sh) - prints raw `systemctl --user show` blocks, parsed by parseUnitStatesOutput(). Never throws for a not-yet-installed unit (see the interactive verification above: `show` on a missing unit still exits 0). */
export function buildQueryUnitStatesScript(unitNames: string[]): string {
  if (unitNames.length === 0) return "true";
  const quoted = unitNames.map((name) => `'${name}'`).join(" ");
  return `systemctl --user show ${quoted} -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState 2>/dev/null || true`;
}

export function parseUnitStatesOutput(output: string): UnitState[] {
  const blocks = output.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const states: UnitState[] = [];
  for (const block of blocks) {
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      fields[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!fields.Id) continue;
    states.push({
      id: fields.Id,
      loadState: fields.LoadState ?? "",
      activeState: fields.ActiveState ?? "",
      subState: fields.SubState ?? "",
      unitFileState: fields.UnitFileState ?? "",
    });
  }
  return states;
}

export type UnitInstallSpec = {
  unitName: PlantLabUnitName;
  content: string;
};

export type UnitConvergenceScriptInput = {
  /** Units to unmask-if-needed, atomically (re)write, and (if startInstalled) enable+start. */
  install: UnitInstallSpec[];
  /** Units to stop and disable (never deleted, never masked) because they are inappropriate for the requested role. */
  stopAndDisable: PlantLabUnitName[];
  /** Enable+start `install` units now. When false, the unit file is written/unmasked but left as-is (used for e.g. a credential-only repair that must not restart a healthy agent). */
  startInstalled: boolean;
  /** Optional plantlab.config.json content to write atomically into the repo root alongside unit convergence. */
  configJson?: string;
  /** Optional secret env file (e.g. the agent credential) to write atomically with 0600/0700 permissions. */
  credentialEnv?: { path: string; content: string } | null;
  /** Force `systemctl restart` on the install units after enable --now, even if they were already active - required whenever a credential/env file changed, since `enable --now` alone is a no-op on an already-running unit and would leave it running with the stale environment. */
  restartInstalled?: boolean;
};

/**
 * The ONE shell fragment used for both local (`sh -s`) and remote
 * (`ssh host sh -s`) role convergence - see roleConvergence.ts. Prints
 * `MASK-CLEARED:<unit>` for every unit that was actually masked before this
 * ran (parsed by the caller), then a final `UNIT-STATES:` block (the same
 * shape buildQueryUnitStatesScript()/parseUnitStatesOutput() produce) so
 * the caller can verify the end state without a second round trip.
 */
export function buildUnitConvergenceScript(input: UnitConvergenceScriptInput, repoPath: string): string {
  const lines: string[] = [
    "set -eu",
    // Prefer $HOME (matches the Node-side path resolution used for
    // config/credential/spool paths via os.homedir()) and only fall back to
    // getent when it's unset - e.g. a non-interactive, non-login `ssh host
    // sh -s` session that doesn't export HOME. Falling back to getent FIRST
    // would silently diverge from the Node-side paths whenever $HOME is
    // deliberately overridden.
    'home_dir="$HOME"',
    'if [ -z "$home_dir" ]; then home_dir="$(getent passwd "$(id -un)" | cut -d: -f6)"; fi',
    'unit_dir="$home_dir/.config/systemd/user"',
    `repo=${shellQuote(repoPath)}`,
    'mkdir -p "$repo" "$unit_dir"',
  ];

  if (input.stopAndDisable.length > 0) {
    const units = input.stopAndDisable.map(shellQuote).join(" ");
    lines.push(`systemctl --user disable --now ${units} >/dev/null 2>&1 || true`);
  }

  for (const spec of input.install) {
    const unit = shellQuote(spec.unitName);
    lines.push(
      `if systemctl --user is-enabled ${unit} 2>/dev/null | grep -q '^masked'; then`,
      `  echo "MASK-CLEARED:${spec.unitName}"`,
      `  systemctl --user unmask ${unit} 2>/dev/null || true`,
      "fi",
      `unit_tmp="$(mktemp "$unit_dir/${spec.unitName}.tmp.XXXXXX")"`,
      `cat > "$unit_tmp" <<'PLANTLAB_UNIT_EOF'`,
      spec.content.trimEnd(),
      "PLANTLAB_UNIT_EOF",
      `chmod 644 "$unit_tmp"`,
      `mv "$unit_tmp" "$unit_dir/${spec.unitName}"`,
    );
  }

  if (input.configJson !== undefined) {
    lines.push(
      `config_tmp="$(mktemp "$repo/plantlab.config.json.tmp.XXXXXX")"`,
      `cat > "$config_tmp" <<'PLANTLAB_CONFIG_EOF'`,
      input.configJson.trimEnd(),
      "PLANTLAB_CONFIG_EOF",
      `mv "$config_tmp" "$repo/plantlab.config.json"`,
    );
  }

  if (input.credentialEnv) {
    const envDir = shellQuote(posixDirname(input.credentialEnv.path));
    const envPath = shellQuote(input.credentialEnv.path);
    lines.push(
      `mkdir -p ${envDir}`,
      `chmod 700 ${envDir}`,
      `umask 077`,
      `env_tmp="$(mktemp ${envDir}/agent.env.tmp.XXXXXX)"`,
      `cat > "$env_tmp" <<'PLANTLAB_ENV_EOF'`,
      input.credentialEnv.content.trimEnd(),
      "PLANTLAB_ENV_EOF",
      `chmod 600 "$env_tmp"`,
      `mv "$env_tmp" ${envPath}`,
      `if [ ! -f ${envPath} ]; then echo "Credential file was not created at ${input.credentialEnv.path}" >&2; exit 20; fi`,
      `env_mode="$(stat -c '%a' ${envPath})"`,
      `if [ "$env_mode" != "600" ]; then echo "Credential file mode is $env_mode, expected 600" >&2; exit 21; fi`,
    );
  }

  lines.push("systemctl --user daemon-reload");

  if (input.startInstalled && input.install.length > 0) {
    const units = input.install.map((spec) => shellQuote(spec.unitName)).join(" ");
    lines.push(`systemctl --user enable --now ${units}`);
    // `enable --now` only *starts* a unit that isn't already running - on
    // an already-active unit it is a no-op, so it will NOT pick up a
    // rewritten EnvironmentFile (e.g. a rotated credential). restartInstalled
    // forces an explicit restart so a new credential always takes effect
    // immediately, whether the unit was previously active or not.
    if (input.restartInstalled) {
      lines.push(`systemctl --user restart ${units}`);
    }
  }

  if (input.install.length > 0 || input.stopAndDisable.length > 0) {
    const allUnits = [...input.install.map((s) => s.unitName), ...input.stopAndDisable];
    lines.push('echo "UNIT-STATES:"', buildQueryUnitStatesScript(allUnits));
  }

  return lines.join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function posixDirname(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx <= 0 ? "/" : value.slice(0, idx);
}
