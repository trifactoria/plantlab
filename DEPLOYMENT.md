# PlantLab production deployment

PlantLab's intended production shape is **two long-running processes on one
local Ubuntu machine with a physically attached camera**:

1. **The web app** - `next start` (built once, then just served).
2. **The camera/scheduler service** - `scripts/camera-service.ts`, which
   manages scheduled capture for every capture-enabled project and every
   shared shelf `CaptureSource`.

Both processes read the same SQLite database and the same on-disk photo
directories. This is not a hosted/multi-tenant deployment model - there is
no separate "production server" the app is pushed to; the machine sitting
next to the camera *is* production.

## Diagnosis of the original failure

Reproduced directly (`npm run build && npm run start`, hitting the running
server with `curl`) rather than guessed:

1. **Every camera-related API route returned `403 Local camera features are
   unavailable in production.`** - `src/lib/localOnly.ts`'s
   `productionLocalOnlyResponse()` unconditionally blocked itself whenever
   `NODE_ENV === "production"`, with no working way to opt back in. An
   existing env var, `PLANTLAB_TEST_LOCAL_CAMERA_UI`, looked like an escape
   hatch (it's checked by several *page* components to decide whether to
   render the camera UI at all) but had **no effect on the underlying API
   routes** - it only ever hid/showed UI. Playwright's screenshot/e2e suite
   "worked" in production mode only because it mocks these routes at the
   network layer, never reaching the real handler. This affected `/api/cameras`,
   every `/api/projects/[id]/camera/*` route, every `/api/capture-sources/*`
   route, and **`/api/service-status`** (the heartbeat endpoint), plus a
   second, separate inline copy of the same check in
   `/api/projects/[id]/photos/capture` that didn't even reference the escape
   hatch. This was the direct, sole cause of "camera access, previews, and
   capture behavior do not work in production."
2. **A stray `next dev` process left running against the same repo checkout
   corrupted the production build** (`TypeError: a[d] is not a function` in
   `webpack-runtime.js`, and a 500 on every page) - `next dev` and
   `next build`/`next start` must never run concurrently against the same
   `.next` directory. Not a code bug, but a real operational hazard worth
   guarding against (see "Restarting either process" below and the doctor
   check).
3. **The cross-process camera lock (`src/lib/fileLock.ts`) and several data
   directory defaults (`src/lib/projectPaths.ts`, `src/lib/backup.ts`)
   resolved paths from `process.cwd()` independently, with no shared source
   of truth.** The camera lock in particular is safety-critical: it is what
   serializes hardware access *between the web app and the camera service*
   (two separate processes) - if the two processes are ever launched with
   different working directories, they silently stop agreeing on where the
   lock lives and camera access is no longer actually serialized between
   them. Fixed by introducing `src/lib/paths.ts` as the one place every
   data/photo/capture/backup/lock path is resolved from (see "Path
   normalization" below).
4. **`tsx` (needed to run `scripts/camera-service.ts` and `scripts/backup.ts`)
   was a devDependency.** A production install that omits dev dependencies
   (`npm ci --omit=dev`) would silently be unable to start the camera
   service. Moved to `dependencies` - see "Why `tsx` and not a compiled
   build" below.
5. **Ruled out** (checked, not just assumed): `DATABASE_URL` resolution -
   Prisma's generated client resolves a relative `file:` SQLite URL relative
   to `prisma/schema.prisma`'s location and auto-loads `.env` from the
   repository root, both independent of the process's `cwd` at runtime
   (verified by requiring the client from `/tmp`). `ffmpeg`/`v4l2-ctl`
   executable discovery - both are plain `/usr/bin` installs found via the
   inherited `PATH`, which is not camera-route-specific. Next.js
   runtime/bundling - every camera route already declares
   `export const runtime = "nodejs"`; nothing is running in an incompatible
   runtime, and native modules (`sharp`, `child_process`) are only ever
   imported by Node-runtime route handlers, never by client components.

## Why `tsx` and not a compiled build

The task allows either. Compiling `scripts/*.ts` to plain JS would mean a
second build pipeline (a separate `tsconfig` with an `outDir`, either
duplicating or reworking the path-alias setup, and a second "did the build
run" failure mode to diagnose) for four small scripts that already run fine
under `tsx`. Moving `tsx` from `devDependencies` to `dependencies` fixes the
actual production gap (a `--omit=dev` install silently missing it) with a
one-line change and no new build system. Revisit this if the camera service
grows enough to justify it.

## Path normalization

`src/lib/paths.ts` is the single source of truth for every filesystem path
PlantLab uses. Both processes resolve the repository root the same way:

1. `PLANTLAB_ROOT_DIR`, if set - an explicit override for deployments where
   the working directory can't be trusted.
2. `process.cwd()` otherwise - correct for `next start` (which itself
   requires being launched from the project root) and for `npm run <script>`
   (which always sets `cwd` to the package root).

Everything else (`data/projects`, `data/capture-sources`,
`data/runtime/locks` - the cross-process camera lock directory, `backups`,
the resolved SQLite file path) is derived from that root and resolved to an
**absolute path**. Both the web process (via `src/instrumentation.ts`) and
the camera service (at the top of `scripts/camera-service.ts`) log the
fully-resolved paths once at startup - check `journalctl` if a deployment
ever behaves as though it can't find its data.

The example systemd units set `PLANTLAB_ROOT_DIR` explicitly (in addition to
`WorkingDirectory`) as defense in depth.

## Production commands

Run these from the repository root.

### Build

```bash
npm install
npm run db:generate
npm run build
```

(`npm run db:generate` is usually a no-op if `node_modules/.prisma` is
already current, but is cheap and safe to always run before a build.)

### Start the web process

```bash
NODE_ENV=production PLANTLAB_LOCAL_CAMERA_ENABLED=1 npm run start
```

`PLANTLAB_LOCAL_CAMERA_ENABLED=1` is what makes camera routes work in
production - see "Diagnosis" above. Without it, PlantLab still runs, but
every camera-hardware feature (enumeration, preview, direct capture, shelf
layout editor, service status) returns a clear 403 instead of touching
hardware. That's the correct default for anything that isn't this exact
local-machine-with-a-camera deployment.

### Start the camera/scheduler process (separate terminal, or systemd)

```bash
npm run camera:service
```

### Stop either process cleanly

`Ctrl-C` (SIGINT) or `kill <pid>` (SIGTERM). Both are handled explicitly by
`scripts/camera-service.ts`: the current scheduling pass finishes, a final
heartbeat is written, and `prisma.$disconnect()` runs before exit - an
in-progress capture is never left half-written (see "Graceful service
behavior" below). `next start` handles SIGTERM/SIGINT the same way on its
own.

### Production readiness check

```bash
npm run doctor
```

Read-only by default. Add `-- --capture` (optionally `--capture=/dev/videoN`)
to also perform one real hardware test capture - the frame is verified and
then deleted; nothing is written to the database or to any project's photo
directory. See "Production doctor command" below for what it checks.

## Development-mode regression: `node:fs/promises` in the client graph

A later commit that added `src/instrumentation.ts` (startup path logging)
broke `npm run dev`/`pnpm dev` entirely - every route returned 500 with:

```
⨯ node:fs/promises
Module build failed: UnhandledSchemeError: Reading from "node:fs/promises"
is not handled by plugins.
Import trace for requested module:
node:fs/promises
./src/lib/paths.ts
```

**Root cause, confirmed by bisection (not guessed):** Next.js compiles
`src/instrumentation.ts` for an edge-compatible webpack target in addition
to the Node target, and that edge-target compile has **no Node builtin
resolution at all**. `instrumentation.ts` dynamically imported
`./lib/paths` (guarded by `if (process.env.NEXT_RUNTIME !== "nodejs")
return;`), and that module has a top-level `import path from "node:path"`
and a dynamic `import("node:fs/promises")`. The runtime guard doesn't help:
webpack still has to produce a valid bundle for both compilation targets
regardless of which branch actually executes. Verified empirically that
**any** Node builtin import reachable from `instrumentation.ts` reproduces
the failure - static or dynamic, `node:`-prefixed or bare, and even with
zero other imports in the file (a lone `import path from "node:path"` at
the top of `instrumentation.ts` itself was enough).

**Fix:**
- `src/instrumentation.ts` now inlines the ~10 lines of logic it needs
  (`process.cwd()`/`process.env` only - no imports of any kind) instead of
  importing the shared resolver. This is documented at the top of the file
  itself so a future "helpfully" re-added shared import doesn't reintroduce
  the bug.
- `src/lib/paths.ts` and `src/lib/projectPaths.ts` were renamed to
  `paths.server.ts`/`projectPaths.server.ts` and given a runtime guard
  (`if (typeof window !== "undefined") throw ...`) establishing an explicit
  server-only boundary, in case a Client Component ever imports them
  directly (confirmed via a full static reverse-dependency-graph walk that
  none currently does). The `server-only` npm package was deliberately
  **not** used - its poison-pill only no-ops under Next's "react-server"
  bundler condition, which plain Vitest and `tsx` don't set, so it broke
  the entire unit test suite and would have equally broken `npm run
  doctor`/`npm run camera:service`.
- `tests/unit/importBoundaries.test.ts` statically walks the real import
  graph (not a hand-maintained allowlist) from `instrumentation.ts` and
  every `"use client"` component, and fails if either can reach a module
  with a top-level Node builtin import - verified to catch the exact
  regression above by temporarily reverting the fix and confirming the
  test fails.

## Orphan project directories

`data/projects/` was accumulating empty, never-cleaned-up directories for
projects that no longer exist. **Root cause:** two code paths eagerly
created a project's photo directory before any photo was ever written to
it: (1) `POST /api/projects` created it unconditionally at project-creation
time, and (2) `GET /api/service-status` - polled every 10 seconds by the
home page's `ServiceStatusPanel` - called `checkCaptureEligibility()` for
*every* project in the database on every poll, which called
`mkdir(..., {recursive:true})` as an "eligibility" probe regardless of
whether the project was even capture-enabled. Combined with
`DELETE /api/projects/[id]`'s intentional, unchanged policy of preserving
a project's photo directory after deletion (so real photos are never
silently lost), every project that was created and then deleted before its
first real capture - overwhelmingly e2e test throwaway projects - left a
permanent empty directory behind.

**Fix:** path resolution and eligibility checks are now strictly read-only
(`isDirectoryUsable()` in `src/lib/projectPaths.server.ts` probes
writability via `fs.access`/`fs.stat`, walking up to the nearest existing
ancestor - it never calls `mkdir`). Only `ensureDirectoryExists()`, called
solely by code that is about to write a file (a capture, an upload, a
fan-out derived photo), actually creates a directory. `DELETE
/api/projects/[id]`'s preserve-on-delete behavior is unchanged.

Run `npm run data:doctor` for a full audit (dry-run, read-only) comparing
the database against `data/projects/`, and `npm run data:doctor --
--remove-empty-orphans` to clean up qualifying empty orphans (real
directories only, never symlinks, never non-empty, only immediate children
of the projects-data root not referenced by any current project ID, and
only those older than a one-hour safety interval by default - see
`src/lib/dataDoctor.server.ts`). `npm run doctor` surfaces an orphan-count
`WARN` pointing at `data:doctor` but never deletes anything itself.

## Graceful service behavior

- `scripts/camera-service.ts` already handled `SIGINT`/`SIGTERM` before this
  task (stops after the in-progress scheduling pass, writes a final
  heartbeat, disconnects Prisma) - preserved unchanged.
- Startup now runs explicit checks first (`ffmpeg` present, data/lock
  directories writable) and **fails fast with a clear error** if a required
  dependency is missing, rather than failing confusingly on the first
  capture attempt.
- An in-progress capture is never corrupted by a restart: photos are always
  written to a temporary path first and only renamed into place after a
  successful, complete capture (pre-existing behavior in `src/lib/camera.ts`
  and `src/lib/sourceCapture.ts`, unrelated to this task but verified still
  intact).
- Errors are logged as structured JSON lines (`consoleLogger` in
  `src/lib/captureService.ts`) so `journalctl -o cat` output stays
  greppable.

## systemd deployment

See `deploy/systemd/README.md` for full detail. Summary:

```bash
./deploy/systemd/install.sh
systemctl --user daemon-reload
systemctl --user enable --now plantlab-web.service plantlab-camera.service
```

This writes (but does not enable/start) `~/.config/systemd/user/plantlab-web.service`
and `~/.config/systemd/user/plantlab-camera.service` from the reviewed
templates in `deploy/systemd/`. Both:

- run as your normal login user via a systemd **user** unit (no root, no
  hardcoded username - the pre-existing pattern this task follows),
- set `WorkingDirectory` and `PLANTLAB_ROOT_DIR` to the repository path,
- restart automatically after an ordinary failure (`Restart=on-failure`,
  `RestartSec=5` - a real misconfiguration, e.g. a missing `ffmpeg`, still
  fails every restart rather than looping silently, so `systemctl --user
  status` surfaces it instead of hiding it behind endless quiet retries),
- wait for `network-online.target`,
- log to the systemd journal (`journalctl --user -u <unit> -f`).

## Environment loading

- **Prisma / `DATABASE_URL`**: auto-loaded by `@prisma/client` from `.env`
  at the repository root, independent of both processes' working directory
  (verified - see "Diagnosis"). No action needed beyond keeping `.env`
  present.
- **Everything else** (`CAMERA_DEVICE`, `PLANTLAB_LOCAL_CAMERA_ENABLED`,
  `PLANTLAB_ROOT_DIR`, `CAPTURE_SERVICE_REFRESH_INTERVAL_MS`, ...): Next.js
  itself auto-loads `.env.local`/`.env.production`/`.env.production.local`
  for the **web process only**. The camera service is a plain script, not a
  Next.js process, so it does **not** get that auto-loading - use systemd's
  `EnvironmentFile=` (already wired up in the provided templates to
  `.env.local` and a per-service file under `~/.config/plantlab/`) or export
  the variables in the shell that starts it manually.
- Never print the contents of any env var in logs - `src/instrumentation.ts`
  and `scripts/camera-service.ts` log resolved **paths**, never raw
  environment values, and `npm run doctor` reports pass/fail with paths and
  device names only.

## Reproducing this deployment on another Ubuntu laptop (e.g. `bokchoy`)

```bash
sudo apt update
sudo apt install -y ffmpeg v4l-utils git
# Ubuntu's own apt repos often ship a Node.js too old for Next.js 15
# (this project needs Node 18.18+, ideally 20+) - use NodeSource or nvm
# instead of `apt install nodejs`:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # confirm 18.18+ before continuing
git clone <repo-url> plantlab
cd plantlab
npm install
cp .env.example .env   # if present; otherwise create .env with DATABASE_URL="file:./dev.db"
npm run db:push        # creates prisma/dev.db if it doesn't exist yet
npm run db:generate
rm -rf .next
npm run build
npm run doctor          # fix anything reported FAIL before continuing
npm run data:doctor     # check for orphan project directories; add --remove-empty-orphans to clean up
sudo usermod -aG video "$USER"   # only if doctor's camera-groups check fails
# log out and back in if you just changed group membership, then:
npm run doctor -- --capture     # optional real hardware smoke test
./deploy/systemd/install.sh
systemctl --user daemon-reload
systemctl --user enable --now plantlab-web.service plantlab-camera.service
systemctl --user status plantlab-web.service plantlab-camera.service
curl -s http://localhost:3000/api/service-status
```

## Cross-machine validation commands

### XPS (development sandbox)

```bash
git switch dev
git pull
pnpm install
rm -rf .next
pnpm typecheck
pnpm test:unit
pnpm dev
```

Then verify `/`, a project dashboard, project settings, camera setup, and
`/capture-sources` all load (see "Development-mode regression" above for
exactly what this now catches).

### bokchoy (production target)

Before changing any service configuration:

```bash
git switch dev
git pull
pnpm install
rm -rf .next
pnpm build
pnpm doctor
pnpm doctor -- --capture
```

Then verify both production processes manually (`pnpm start` in one
terminal, `pnpm camera:service` in another - see "Production commands"
above) before enabling either systemd unit. Do not touch or delete
canonical project data during validation - `pnpm data:doctor` (without
`--remove-empty-orphans`) is safe to run any time; only pass
`--remove-empty-orphans` once you've reviewed its dry-run output.

## Known limitations

- Validated with the mocked `/dev/video-test` device (the existing
  convention for every camera test in this repo) plus, on this development
  sandbox, real `/dev/video0`-`/dev/video7` hardware (an integrated webcam
  and a Logitech BRIO) - `npm run doctor -- --capture` and a full production
  `/api/cameras` round trip were both exercised against real hardware here.
  Real Logitech-on-Ubuntu-laptop behavior on `bokchoy` specifically (exact
  udev/group setup, exact V4L2 driver quirks) has not been verified -
  `npm run doctor` on that machine is the fastest way to confirm it before
  relying on it.
- The `camera-groups` doctor check probes real `/dev/video*` access
  directly when a device is present (the ground truth) and only falls back
  to a `/etc/group` heuristic when no device exists yet to probe - on a
  machine using a non-standard ACL grant instead of `video` group
  membership, the check will correctly still pass.
- This task intentionally does not touch PostgreSQL, remote/Tailscale
  capture agents, mobile uploads, or storage archiving - SQLite and the
  existing photo-directory layout are unchanged.
- `tests/unit/photoIngestRoutes.test.ts`'s before/after `Photo` count
  assertion is occasionally flaky **only** when the full suite runs (all
  test files concurrently against one shared real SQLite database) - it
  passes reliably in isolation every time it was tried. This is pre-existing
  test-infrastructure behavior (confirmed unrelated to any change in this
  task by running it standalone repeatedly), not a product bug: Vitest runs
  test files in parallel by default, and any other file's concurrent
  `Photo` row creation/cleanup can shift the count between this one test's
  two snapshots. Not fixed here - out of scope (would need either
  sequential test execution or a per-worker isolated database).
