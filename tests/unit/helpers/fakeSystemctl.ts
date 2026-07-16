import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A fake `systemctl` executable that simulates real systemd --user
 * semantics closely enough to exercise convergeNodeRole()'s actual mask
 * detection/clearing logic end to end, without needing a real systemd
 * user session (portable across dev machines and CI). State is tracked as
 * plain marker files in a scratch directory - no real systemd/dbus
 * involved.
 *
 * Supports exactly what convergeNodeRole()/systemdUnits.ts and the edge
 * attach lifecycle helpers call: `cat`, `is-enabled`, `is-active`, `mask`,
 * `unmask`, `enable --now <units...>`, `disable --now <units...>`,
 * `daemon-reload`, `status`, and `show <units...> -p ...`.
 */
export type FakeSystemctl = {
  binDir: string;
  stateDir: string;
  /** Pre-masks a unit, simulating a stale mask left by an earlier installation - matches the real bokchoy failure scenario. */
  preMask(unit: string): Promise<void>;
  isMasked(unit: string): Promise<boolean>;
  isActive(unit: string): Promise<boolean>;
  isEnabled(unit: string): Promise<boolean>;
  actions(): Promise<string[]>;
  cleanup(): Promise<void>;
};

export async function createFakeSystemctl(): Promise<FakeSystemctl> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "plantlab-fake-systemctl-bin-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "plantlab-fake-systemctl-state-"));

  const scriptPath = path.join(binDir, "systemctl");
  await writeFile(
    scriptPath,
    String.raw`#!/bin/sh
set -eu
STATE="${stateDir}"
if [ "$1" != "--user" ]; then echo "fake systemctl only supports --user" >&2; exit 1; fi
shift
action="$1"; shift

case "$action" in
  daemon-reload)
    exit 0
    ;;
  cat)
    u="$1"
    if [ -f "$STATE/$u.masked" ] || [ -f "$STATE/$u.enabled" ] || [ -f "$STATE/$u.active" ]; then
      printf '[Unit]\nDescription=%s\n' "$u"
      exit 0
    fi
    echo "No files found for $u." >&2
    exit 1
    ;;
  mask)
    for u in "$@"; do touch "$STATE/$u.masked"; rm -f "$STATE/$u.enabled" "$STATE/$u.active"; done
    exit 0
    ;;
  unmask)
    for u in "$@"; do rm -f "$STATE/$u.masked"; done
    exit 0
    ;;
  is-enabled)
    u="$1"
    if [ -f "$STATE/$u.masked" ]; then echo "masked"; exit 1; fi
    if [ -f "$STATE/$u.enabled" ]; then echo "enabled"; exit 0; fi
    echo "disabled"; exit 1
    ;;
  is-active)
    u="$1"
    if [ -f "$STATE/$u.active" ]; then echo "active"; exit 0; fi
    echo "inactive"; exit 3
    ;;
  enable|start)
    now=0
    units=""
    for arg in "$@"; do
      if [ "$arg" = "--now" ]; then now=1; else units="$units $arg"; fi
    done
    for u in $units; do
      if [ -f "$STATE/$u.masked" ]; then
        echo "Failed to enable unit: Unit $STATE/$u is masked" >&2
        exit 1
      fi
      touch "$STATE/$u.enabled"
      if [ "$now" = "1" ] || [ "$action" = "start" ]; then touch "$STATE/$u.active"; fi
    done
    exit 0
    ;;
  disable|stop)
    now=0
    units=""
    for arg in "$@"; do
      if [ "$arg" = "--now" ]; then now=1; else units="$units $arg"; fi
    done
    for u in $units; do
      rm -f "$STATE/$u.enabled"
      if [ "$now" = "1" ] || [ "$action" = "stop" ]; then rm -f "$STATE/$u.active"; fi
    done
    exit 0
    ;;
  restart)
    for u in "$@"; do echo "restart $u" >> "$STATE/actions.log"; touch "$STATE/$u.enabled" "$STATE/$u.active"; done
    exit 0
    ;;
  status)
    u="$1"
    if [ -f "$STATE/$u.active" ]; then
      printf '%s active (running)\n' "$u"
      exit 0
    fi
    printf '%s inactive\n' "$u"
    exit 3
    ;;
  show)
    units=""
    for arg in "$@"; do
      case "$arg" in
        -p|--property|-p*|Id|LoadState|ActiveState|SubState|UnitFileState) ;;
        *) units="$units $arg" ;;
      esac
    done
    first=1
    for u in $units; do
      if [ "$first" = "1" ]; then first=0; else printf '\n'; fi
      if [ -f "$STATE/$u.masked" ]; then
        printf 'Id=%s\nLoadState=masked\nActiveState=inactive\nSubState=dead\nUnitFileState=masked\n' "$u"
      elif [ -f "$STATE/$u.active" ]; then
        printf 'Id=%s\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n' "$u"
      elif [ -f "$STATE/$u.enabled" ]; then
        printf 'Id=%s\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n' "$u"
      else
        printf 'Id=%s\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n' "$u"
      fi
    done
    exit 0
    ;;
  *)
    echo "fake systemctl: unsupported action $action" >&2
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  );

  return {
    binDir,
    stateDir,
    async preMask(unit: string) {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, `${unit}.masked`), "");
    },
    async isMasked(unit: string) {
      return fileExists(path.join(stateDir, `${unit}.masked`));
    },
    async isActive(unit: string) {
      return fileExists(path.join(stateDir, `${unit}.active`));
    },
    async isEnabled(unit: string) {
      return fileExists(path.join(stateDir, `${unit}.enabled`));
    },
    async actions() {
      const { readFile } = await import("node:fs/promises");
      return readFile(path.join(stateDir, "actions.log"), "utf8")
        .then((contents) => contents.trim().split("\n").filter(Boolean))
        .catch(() => []);
    },
    async cleanup() {
      await rm(binDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function fileExists(p: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  return access(p)
    .then(() => true)
    .catch(() => false);
}

/** Prepends `dir` to PATH for the duration of a test; returns a restore function. */
export function prependPath(dir: string): () => void {
  const original = process.env.PATH;
  process.env.PATH = `${dir}:${original ?? ""}`;
  return () => {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  };
}
