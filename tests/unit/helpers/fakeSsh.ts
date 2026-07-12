import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A fake `ssh`/`scp` pair that makes runRemoteShell()/scp-based remote
 * operations (roleConvergence.ts, credentialRepair.ts, edgeAgentInstall.ts)
 * run their exact real code against a *local* directory tree instead of a
 * real network host - `ssh <host> sh -s -- args` simply execs `sh -s --
 * args` locally (dropping the host argument), inheriting stdin/stdout so
 * the calling code's script is interpreted identically to a real remote
 * session. Combine with an isolated $HOME (see roleConvergence.test.ts's
 * pattern) so "remote" filesystem state never touches anything real.
 */
export type FakeSsh = {
  binDir: string;
  cleanup: () => Promise<void>;
};

export async function createFakeSsh(): Promise<FakeSsh> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "plantlab-fake-ssh-bin-"));

  await writeFile(
    path.join(binDir, "ssh"),
    String.raw`#!/bin/sh
# Real invocation shape used by shellExec.ts: ssh [flags...] <host> sh -s -- [args...]
# Drop leading flag/value pairs and the host, then exec the remainder
# (sh -s -- args...) so stdin (the script) passes through untouched.
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift # drop host
exec "$@"
`,
    { mode: 0o755 },
  );

  // Built as plain (non-template) string lines - shell parameter expansion
  // syntax like `${dest#*:}` is indistinguishable from a JS template
  // substitution inside a `${}`-tagged template literal, so this avoids
  // that trap entirely (same reason systemdUnits.ts builds its scripts as
  // an array of plain strings rather than one big template literal).
  const scpScriptLines = [
    "#!/bin/sh",
    "# Real invocation shape used by edgeAgentInstall.ts: scp -r -o BatchMode=yes <src> <host:dest>",
    "set -eu",
    'src=""',
    'dest=""',
    'prev=""',
    'for a in "$@"; do',
    '  case "$a" in',
    "    -*) continue ;;",
    "  esac",
    '  case "$prev" in',
    '    -o) prev=""; continue ;;',
    "  esac",
    '  if [ -z "$src" ]; then src="$a"; else dest="$a"; fi',
    '  prev="$a"',
    "done",
    'dest_path="' + "$" + "{dest#*:}" + '"',
    'case "$dest_path" in',
    '  /*) target="$dest_path" ;;',
    '  *) target="$HOME/$dest_path" ;;',
    "esac",
    'rm -rf "$target"',
    'cp -r "$src" "$target"',
    "",
  ];
  await writeFile(path.join(binDir, "scp"), scpScriptLines.join("\n"), { mode: 0o755 });

  return {
    binDir,
    cleanup: async () => {
      await rm(binDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Isolated $HOME for a "remote" filesystem, matching roleConvergence.test.ts's pattern. */
export async function createFakeRemoteHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "plantlab-fake-remote-home-"));
  await mkdir(home, { recursive: true });
  return {
    home,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
