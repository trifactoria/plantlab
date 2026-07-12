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

## PlantLab CLI

`plantlab` (`bin/plantlab`, run directly or via `npm run <script>` wrappers
below) is the canonical operational interface - see `ARCHITECTURE.md` for
the full design rationale. It is a thin launcher (`bin/plantlab`) that runs
`src/cli/index.ts` under `tsx`, matching how every other operational script
in this repo already runs (no separate compiled build for tooling).

```bash
plantlab version                 # print the app version
plantlab doctor                  # structured health report (see below)
plantlab doctor --capture        # also exercise real camera hardware
plantlab doctor storage          # detailed orphan/stale-file audit + cleanup
plantlab install                 # interactive role setup (see "Node roles")
plantlab service status|start|stop|restart   # systemctl --user wrapper
plantlab node list|info|discover             # this node + SSH-config candidates
plantlab camera list|attach|test [device]    # local hardware camera commands
plantlab camera list --node xps              # coordinator view of node cameras
plantlab capture test --node xps             # remote manual capture test
plantlab backup create|list|verify|restore   # see "Backups" below
plantlab project list|show|set-lifecycle     # see "Project lifecycle" below
```

Every command is a thin wrapper around shared logic in `src/lib/` (mostly
`src/lib/operations/`) - the CLI never re-implements a check or workflow
that already exists; the health-check logic in particular is shared
verbatim with the web dashboard's `GET /api/health` (see "Production
readiness check" below).

**Compatibility wrappers**: `npm run doctor`, `npm run data:doctor`,
`npm run backup`, and `npm run backup:list` still work exactly as before -
they now call `bin/plantlab doctor`, `bin/plantlab doctor storage`,
`bin/plantlab backup create`, and `bin/plantlab backup list` respectively,
rather than duplicating any logic. `scripts/doctor.ts`, `scripts/dataDoctor.ts`,
and `scripts/backup.ts` have been removed - their logic now lives in
`src/lib/operations/doctor.ts` and `src/lib/backup.ts`, consumed by both the
CLI and (for doctor) the web API. `scripts/camera-*.ts` and
`scripts/agent-ingest-upload.sh` are unaffected.

## Remote camera-node workflow

The first supported multi-machine workflow is a coordinator with a canonical
SQLite database and image storage, plus a camera node that captures locally
and uploads frames back over ordinary HTTP. SSH is used only for inspection,
enrollment, configuration, and systemd management.

Before attaching nodes, apply the additive coordinator migration:

```bash
pnpm db:generate
pnpm db:push
```

No existing project, photo, backup, capture source, or source capture is
modified by that migration. The new tables store deployment metadata only:
nodes, hashed node credentials, node camera inventory, node-to-capture-source
assignments, and manual capture jobs.

From the coordinator, the intended G70/XPS validation flow is:

```bash
plantlab node inspect xps
plantlab node attach xps --coordinator-url http://plantlab:3000
plantlab camera list --node xps
plantlab camera attach --node xps
plantlab capture test --node xps
```

`plantlab node attach` rotates a per-node credential, writes
`plantlab.config.json` in the remote repository, writes the raw credential to
the remote user's `~/.config/plantlab/agent.env` with `0600` permissions, and
installs/starts `plantlab-agent.service` as a user-level systemd service. The
default spool root is the remote user's
`~/.local/state/plantlab-agent`; pass `--spool-root /var/lib/plantlab-agent`
only if that directory already belongs to the non-root PlantLab service user.

The agent runtime (`pnpm agent:service`) keeps its own local
`state.sqlite` under the spool root. It captures a frame to local spool first,
then uploads it to `/api/agent-ingest` using the node credential. The
coordinator acknowledges the job only after the canonical `SourceCapture` is
created; failed uploads remain in the local spool for retry.

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
4. **`tsx` (needed to run `scripts/camera-service.ts` and the `plantlab` CLI)
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
plantlab doctor
# or: npm run doctor
```

Read-only by default. Add `--capture` (optionally `--capture=/dev/videoN`)
to also perform one real hardware test capture - the frame is verified and
then deleted; nothing is written to the database or to any project's photo
directory.

Output is grouped into: Environment, Database, Storage, Camera, Capture
Service, Build, Node Status, Backups. `plantlab doctor storage` (or
`npm run data:doctor`) gives the full orphan-project-directory and
stale-ingest-file audit with optional `--remove-empty-orphans`/
`--remove-stale-ingest-files` cleanup flags - `plantlab doctor`'s own
Storage section only ever summarizes counts, never deletes anything.

The same report is available as JSON at `GET /api/health` (subject to the
same `PLANTLAB_LOCAL_CAMERA_ENABLED` production gate as every other camera
route - see "Diagnosis" above) via the shared `runDoctorReport()` function
in `src/lib/operations/doctor.ts` - the CLI and the web app read one
implementation, never two.

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

Run `plantlab doctor storage` (or `npm run data:doctor`) for a full audit
(dry-run, read-only) comparing the database against `data/projects/`, and
`plantlab doctor storage --remove-empty-orphans` to clean up qualifying
empty orphans (real directories only, never symlinks, never non-empty, only
immediate children of the projects-data root not referenced by any current
project ID, and only those older than a one-hour safety interval by default
- see `src/lib/dataDoctor.server.ts`). `plantlab doctor`'s own Storage
section surfaces an orphan-count `WARN` pointing at `doctor storage` but
never deletes anything itself.

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
plantlab install --role standalone   # or: ./deploy/systemd/install.sh directly
systemctl --user daemon-reload
systemctl --user enable --now plantlab-web.service plantlab-camera.service
```

`plantlab install` is the preferred entry point (see "PlantLab CLI" above
and `ARCHITECTURE.md`): it validates dependencies, prepares every data/
backup/lock/ingest directory, records the chosen role in
`plantlab.config.json`, and then shells out to the exact same
`deploy/systemd/install.sh` described below (no unit-generation logic is
duplicated between them) - pass `--skip-systemd` to do everything except
that last step, e.g. in a dev sandbox with no systemd user session.
Afterward, use `plantlab service status|start|stop|restart` as the
preferred way to drive `systemctl` for both units together.

Running `./deploy/systemd/install.sh` directly still works unchanged and
does exactly what it always did - it writes (but does not enable/start)
`~/.config/systemd/user/plantlab-web.service` and
`~/.config/systemd/user/plantlab-camera.service` from the reviewed
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

## Node roles and `plantlab.config.json`

`plantlab install` records this machine's role in
`<PLANTLAB_ROOT_DIR>/plantlab.config.json` (gitignored, node-local, never
included in a backup archive - see `src/lib/operations/config.ts`):
`coordinator`, `camera-node`, `standalone` (today's default single-machine
shape), `microscope-node`, or `mobile-uploader`. Only `standalone` has any
real behavioral effect today - **none, identically to before this file
existed** - the others exist purely so there is a durable, real place to
record intent ahead of the actual multi-node capture-agent protocol, which
is explicitly out of scope for this task (see `ARCHITECTURE.md`).
`plantlab node info` shows this machine's configured role;
`plantlab node list`/`plantlab node discover` additionally surface
candidate machines from `~/.ssh/config` - informational only, nothing is
verified reachable or registered anywhere.

## Project lifecycle

`Project.lifecycleState` (nullable string column, additive migration) is
purely informational metadata today: `ACTIVE`, `COMPLETE`, `UNANNOTATED`,
`ANNOTATED`, `ARCHIVED`, `PUBLISHED` (see `src/lib/projectLifecycle.ts`).
Every project created before this field existed has `lifecycleState: null`,
which application code always treats identically to `ACTIVE` - **zero
behavior change** for existing projects; nothing currently reads this field
to alter scheduling, capture, or visibility. Manage it via:

```bash
plantlab project list                          # id, name, lifecycle, camera
plantlab project show <projectId>               # + capture status
plantlab project set-lifecycle <projectId> ARCHIVED
```

This is the foundation for future backup/publication workflows (a project
lifecycle snapshot is already recorded in every new backup's manifest - see
"Backups" below) - no automatic transitions, no enforced ordering, and no
file movement happen today; see `ARCHITECTURE.md`'s "Explicitly out of
scope" for what's deferred.

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
plantlab doctor              # fix anything reported FAIL before continuing
plantlab doctor storage      # check for orphan project directories; add --remove-empty-orphans to clean up
sudo usermod -aG video "$USER"   # only if doctor's camera-groups check fails
# log out and back in if you just changed group membership, then:
plantlab doctor --capture    # optional real hardware smoke test
plantlab install --role camera-node   # or coordinator/standalone - generates systemd units too
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
- ~~`tests/unit/photoIngestRoutes.test.ts`'s before/after `Photo` count
  assertion is occasionally flaky only when the full suite runs~~ - fixed by
  the test-isolation work below (every test file now runs against its own
  private SQLite database copy, so no test file's `Photo` row can shift
  another's count).
- The remote HTTP ingest endpoint (below) currently supports a single
  shared coordinator-wide token (`PLANTLAB_INGEST_TOKEN`/`_HASH`), not
  per-agent credentials, and only JPEG/PNG images. It does not yet
  implement the full capture-agent job protocol, PostgreSQL, Supabase, T9
  archiving, schedule leases, mobile applications, or public Vercel export
  - those are explicitly out of scope for this task.
- `plantlab node`/`camera attach` are intentionally thin in this task: node
  discovery only reads `~/.ssh/config`, never verifies reachability or
  registers anything; `camera attach` lists locally discovered hardware but
  does not itself register a `CaptureSource` (use the web UI or
  `POST /api/capture-sources`) - see `ARCHITECTURE.md` for why this is
  deferred to the actual capture-agent protocol rather than half-built now.
- `plantlab backup restore` is extract-only by design (see "Backups" above)
  - it never performs a live database/data swap automatically, and no
  remote backup destination (external SSD, remote coordinator, NAS, cloud)
  is implemented, only the `BackupDestination` interface.
- Project lifecycle transitions are not validated against any particular
  order (`set-lifecycle` accepts any listed state from any other state) -
  enforcing a real state machine is deferred until an actual workflow (e.g.
  publication) depends on one.
- This task does not implement a `packages/` monorepo split - see
  `ARCHITECTURE.md` "Repository organization" for the reasoning and what
  would trigger reconsidering it.

## Test isolation (unit tests never touch real PlantLab data)

Automated unit/route tests (`npm run test:unit`, i.e. everything under
`tests/unit/**` per `vitest.config.ts`) must never read or write the real
development SQLite database, canonical project photos, real capture-source
files, `data/projects/`, or live camera-service state.

**Architecture** (`tests/unit/setup/globalSetup.ts` + `tests/unit/setup/testEnvironment.ts`):

1. **`globalSetup`** runs once for the whole `vitest run` invocation, in the
   main orchestrating process, before any test file starts. It builds one
   template SQLite database (`prisma db push` against the current
   `prisma/schema.prisma`, so schema changes are picked up automatically -
   no separate test-side migration step) under a temp directory and writes
   its path to a marker file.
2. **`testEnvironment.ts`** (a Vitest `setupFiles` entry) runs before *each
   test file's own imports* - using top-level `await`, not a
   `beforeAll`/hook, because hooks fire too late to influence
   `DATABASE_URL` before `PrismaClient` is constructed at module load time.
   For every test file, it creates a fresh, uniquely-named temp root
   (`database/`, `data/projects/`, `data/capture-sources/`, `data/ingest/`,
   `data/runtime/locks/`, `backups/`), copies the template database into
   it, and points `PLANTLAB_ROOT_DIR`/`DATABASE_URL`/`PLANTLAB_INGEST_DIR`/`PLANTLAB_BACKUP_DIR`
   at that root. An `afterAll` in the same file removes the temp root after
   the file's tests finish.
3. **Defense in depth**: `resolveRootDir()` (`src/lib/paths.server.ts`) and
   the `PrismaClient` constructor (`src/lib/prisma.ts`) both hard-fail with
   a clear, actionable error if `process.env.VITEST` is set (automatically,
   by the Vitest runner itself) but `PLANTLAB_ROOT_DIR`/`DATABASE_URL`
   don't point at an isolated test location - so a future misconfiguration
   of the setup above fails loudly instead of silently touching real data.

Isolation is **per test file**, not per worker: Vitest's default
`isolate: true` re-executes each file's own module graph (including
`setupFiles`) per file, so a "reuse across files" scheme would either not
survive that or risk one file's cleanup racing another file's still-active
temp directory. Per-file isolation costs a handful of `mkdir` calls plus one
`copyFile` per file (not a full `prisma db push` - only `globalSetup` does
that, once) and is strictly simpler and safer.

This is deliberately **not** "make every test run serially" - test files
still run concurrently (Vitest's default), each against its own private
database and filesystem copy, so true cross-test races stay caught rather
than hidden.

Run `npm run test:unit` repeatedly (or in a loop) to confirm determinism;
the real dev database and `data/projects/` are provably untouched by any
test run (verified during this task: identical `Project`/`Photo` row counts
and `data/projects/` directory count before and after 15+ consecutive full
suite runs, and zero leftover `/tmp/plantlab-test-*` directories after every
run completes).

## Remote HTTP ingest

`POST /api/agent-ingest` lets a capture agent (bokchoy, a future Raspberry
Pi capture node, a future mobile uploader, or manual `curl` testing) upload
one image + metadata for an existing `CaptureSource` over **ordinary HTTP**
- LAN or a Tailscale network route. **Taildrop, Tailscale file-transfer
APIs, SMB, NFS, mounted remote databases, and Git are never used for image
transfer.**

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLANTLAB_INGEST_TOKEN` | one of this or `_HASH` | Raw bearer token the coordinator accepts. Simple to set up; the raw value briefly lives in the coordinator's own environment. |
| `PLANTLAB_INGEST_TOKEN_HASH` | one of this or the raw token | A pre-computed SHA-256 hex digest of the token (`sha256sum` or `printf '%s' "$TOKEN" \| sha256sum`) - preferred once set up, since the raw token never needs to sit in the coordinator's environment. |
| `PLANTLAB_INGEST_DIR` | no | Overrides the default staging directory (`<PLANTLAB_ROOT_DIR>/data/ingest`) where incoming uploads are streamed as `.partial` files before atomic placement. |
| `PLANTLAB_INGEST_MAX_BYTES` | no | Overrides the default 50 MiB per-upload size limit. |

This is a **single shared coordinator-wide token**, documented here as a
temporary scheme for a private home network - every agent currently
presents the same token. Authentication is isolated in
`src/lib/ingestAuth.server.ts` specifically so it can later be replaced
with per-agent credentials without touching the route or the ingest
pipeline. Raw tokens are never logged; only SHA-256 digests are compared
(constant-time), and malformed/missing/invalid credentials all return
`401`.

### Request format

`multipart/form-data` with two parts:

- **`metadata`** (JSON): `captureId` (agent-generated idempotency key,
  globally unique), `capturedAt` (ISO date), `captureSourceId` **or**
  `cameraStableId` (at least one required - `captureSourceId` is the
  canonical DB id and is preferred; `cameraStableId` is resolved via a
  `CaptureSource` lookup and must match exactly one row), `originalFilename`,
  `expectedSha256` (64-char hex), `expectedByteSize`, `mimeType`
  (`image/jpeg` or `image/png`).
- **`image`**: the raw image bytes.

### Streaming, validation, and atomic placement

Handled by `src/lib/ingest.server.ts` (`receiveIngestMultipart`,
`validateStagedImage`, `placeStagedFileAtCanonicalPath`):

1. The image streams directly from the request body to a `.partial` file
   under `PLANTLAB_INGEST_DIR` - the complete image is never buffered in
   memory.
2. SHA-256 is computed incrementally as bytes stream through.
3. The configured max size (`PLANTLAB_INGEST_MAX_BYTES`) is enforced
   **during** streaming (`413` as soon as the limit is crossed, not after
   the whole file has landed).
4. Once fully staged, actual byte size and checksum are compared against
   the declared `expectedByteSize`/`expectedSha256` (`400` on mismatch).
5. The staged file is opened with Sharp to confirm it's a real, decodable
   image whose actual format matches the declared `mimeType` (`400` if
   not).
6. Only after every check passes is the file atomically renamed
   (`fs.rename`) into its canonical location - never acknowledged before
   that rename and the database transaction below both succeed.
7. Any failure at any step removes the `.partial` staging file; nothing is
   ever left in the staging directory after a failed or interrupted
   request.

### Storage layout

Canonical files live under `resolveCaptureSourcesDataDir()`
(`<PLANTLAB_ROOT_DIR>/data/capture-sources/`) at:

```
<captureSourceId>/<year>/<month>/<captureId>.jpg
```

(the `<captureId>` is sanitized to strip path-unsafe characters). This is
**not** a new top-level directory - remotely-ingested and locally-driven
capture-source files share the same canonical location. `SourceCapture`
rows created this way store this path in the new `storageKey` column (a
canonical relative path) in addition to the existing absolute `originalPath`
column, plus `sha256`, `byteSize`, `mimeType`, `originalFilename`, and
`ingestSource: "http-agent-ingest"`. All of these columns are nullable -
existing rows and locally-driven camera-service captures leave them `null`;
a separate backfill (not part of this task) could populate them later.
Existing rows are never moved or rewritten by this task.

### Idempotency and status codes

`captureId` is globally unique (`SourceCapture.captureId`, a unique
database column):

| Scenario | Status |
| --- | --- |
| First valid upload | `201 Created` |
| Identical retry (same `captureId`, matching checksum+size) | `200 OK` - returns the original result, creates nothing new |
| Same `captureId`, different checksum/size | `409 Conflict` - original upload is preserved untouched |
| Missing/invalid/malformed auth | `401 Unauthorized` |
| Malformed metadata / invalid or unsupported image | `400 Bad Request` |
| Unknown `captureSourceId`/`cameraStableId` | `404 Not Found` |
| Upload exceeds `PLANTLAB_INGEST_MAX_BYTES` | `413 Payload Too Large` |
| Unexpected coordinator-side failure | `500` (database failure after successful file placement is cleaned up - the canonical file is deleted rather than left untracked) |

A database failure after the file has already been durably placed deletes
the just-placed canonical file rather than leaving an untracked file behind
(`sourceCapture.create` failure path in
`src/app/api/agent-ingest/route.ts`). An interrupted/disconnected upload
never reaches the database step at all, and its `.partial` staging file is
removed as part of the same failure handling.

By default, a successful ingest immediately runs viewport fan-out (the
existing shared `runViewportFanOut()` workflow - one derived, cropped
`Photo` per project with an active `ProjectViewport` on this
`CaptureSource`), matching the intended coordinator workflow. Pass
`?mode=store-only` to store the `SourceCapture` without triggering fan-out.
A retried upload (idempotent 200) never triggers fan-out again, so
duplicate/retried uploads cannot produce duplicate project photos.

### curl verification

`scripts/agent-ingest-upload.sh` is a ready-to-run example client - copy it
(or `curl` directly) to another Ubuntu machine on the same LAN/Tailscale
network as the coordinator:

```bash
PLANTLAB_INGEST_TOKEN=<token> \
CAPTURE_SOURCE_ID=<existing-capture-source-id> \
PLANTLAB_HOST=http://<coordinator-lan-ip>:3000 \
  ./scripts/agent-ingest-upload.sh /path/to/frame.jpg my-capture-001
```

Equivalent raw `curl`:

```bash
EXPECTED_SHA256=$(sha256sum frame.jpg | cut -d' ' -f1)
EXPECTED_BYTE_SIZE=$(stat -c%s frame.jpg)

curl -i -X POST http://<coordinator-lan-ip>:3000/api/agent-ingest \
  -H "Authorization: Bearer $PLANTLAB_INGEST_TOKEN" \
  -F 'metadata={
        "captureId": "my-capture-001",
        "capturedAt": "2026-07-11T12:00:00.000Z",
        "captureSourceId": "<existing-capture-source-id>",
        "originalFilename": "frame.jpg",
        "expectedSha256": "'"$EXPECTED_SHA256"'",
        "expectedByteSize": '"$EXPECTED_BYTE_SIZE"',
        "mimeType": "image/jpeg"
      };type=application/json' \
  -F "image=@frame.jpg;type=image/jpeg"
```

Re-running the exact same command confirms idempotent success (`200 OK`,
same `sourceCaptureId`, no new file/row). Re-running with the same
`captureId` but a different image confirms the conflict path (`409
Conflict`, original preserved).

**Verified during this task** (against a real local server, a real
`CaptureSource`, and two distinct real JPEGs; all verification data - the
`CaptureSource`, its `SourceCapture` row, and its file - was deleted
afterward and confirmed to leave the real database's row counts unchanged):

```
First upload:        HTTP/1.1 201 Created
                      {"status":"created","sourceCaptureId":"...","captureId":"verify-capture-001",
                       "storageKey":"<id>/2026/07/verify-capture-001.jpg","fanOutTriggered":true}
Identical retry:      HTTP/1.1 200 OK
                      {"status":"already-exists","sourceCaptureId":"...","captureId":"verify-capture-001"}
Conflicting retry:    HTTP/1.1 409 Conflict
                      {"error":"captureId \"verify-capture-001\" was already ingested with different
                       content (checksum/size mismatch). The original upload was preserved."}
No Authorization header:  401
Wrong token:               401
```

### Stale ingest file cleanup

A `.partial` staging file should only outlive one request if the process
crashed or was killed mid-upload (an ordinary rejected/failed upload
already cleans up its own `.partial` file). `npm run data:doctor` reports
(dry-run by default) any `.partial` file older than one hour, with
`--remove-stale-ingest-files` to actually delete them - never recently
modified files (a real in-flight upload), never anything outside the
configured ingest directory, and never anything that isn't a plain
`<uuid>.partial` file. `npm run doctor` surfaces a read-only `WARN` with the
count and total bytes, pointing at `data:doctor` for details; ordinary
application startup never performs destructive cleanup.

### Backup implications

`plantlab backup create` archives the whole configured root (database +
`data/`), so ingested `SourceCapture` rows and their canonical files under
`data/capture-sources/` are included automatically - no change needed to
the ingest pipeline. The `.partial` staging directory (`PLANTLAB_INGEST_DIR`)
is not canonical data and doesn't need to be backed up. See "Backups" below
for the full backup architecture.

## Backups

`src/lib/backup.ts` is the one implementation behind `plantlab backup
create|list|verify|restore` (and the `npm run backup`/`backup:list`
compatibility wrappers) - see `ARCHITECTURE.md` for the full design.

**Archive format is unchanged and every existing backup remains fully
restorable**: a `.tar.gz` containing `database.sqlite`, `manifest.json`, and
the project data directory tree, exactly as before this task. What's new is
strictly additive:

- **Checksums**: `manifest.json` (format `"plantlab-backup/2"`) now records
  `databaseSha256` and `archiveSha256`. A backup created before this task
  has neither field - every reader here treats that as "legacy", never as
  an error.
- **Sidecar manifest**: a copy of the manifest is also written next to the
  archive as `<archive>.tar.gz.manifest.json`, so `list`/`verify` can read
  metadata (including the archive checksum) without extracting the whole
  tar. A legacy backup simply has no sidecar.
- **Project lifecycle snapshot**: `manifest.json` records each project's
  `id`/`name`/lifecycle state (see "Project lifecycle" above) at backup
  time - informational only, never consulted by restore.
- **`BackupDestination` abstraction**: `LocalFilesystemDestination` (the
  only implementation today, wrapping the pre-existing behavior of writing
  into `resolveBackupDir()`/`PLANTLAB_BACKUP_DIR`) is the first of what will
  eventually include external-SSD, remote-coordinator, NAS, and cloud
  destinations - **none of those are implemented in this task**, only the
  interface, so the CLI surface (`backup create`) doesn't need to change
  shape when one is added later.

```bash
plantlab backup create              # create + checksum + sidecar manifest
plantlab backup list                # newest last; shows metadata when available
plantlab backup verify <archive>     # structural check + checksum if available
plantlab backup restore <archive> --to <staging-dir>
```

**`backup restore` is intentionally extract-only** - it never overwrites
the live database or `data/` directory automatically, and refuses outright
if `--to` resolves to the live `PLANTLAB_ROOT_DIR`. This follows directly
from this task's safety requirements (no destructive migration, no
automatic cleanup of user data): swapping a restored database/data tree
into place live is exactly the kind of operation that must stay a
deliberate manual step. `restore` verifies the archive first (checksum, if
available) and refuses on failure unless `--force` is passed; either way it
prints the exact manual steps to complete a real restore (stop services,
back up current live data first, copy files, restart).

`plantlab doctor`'s Backups section warns if no backup exists yet or the
most recent one is more than 7 days old - the same `listBackups()` this
section's commands use, not a separate check.
