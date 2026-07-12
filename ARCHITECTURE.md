# PlantLab architecture

PlantLab is transitioning from a single-machine application into a
multi-node platform (coordinator, camera node, standalone, microscope node,
mobile uploader). This document records the architectural decisions made
while building that foundation - the `plantlab` CLI, a shared operational
library, the backup abstraction, and project lifecycle metadata - and what
is deliberately deferred to later work.

See `DEPLOYMENT.md` for day-to-day operational instructions (how to run
each command); this document explains *why* things are organized this way.

## Repository organization

**Decision: keep a single Next.js package at the repository root. Do not
split into a `packages/` pnpm workspace monorepo in this task.**

A monorepo layout (`packages/plantlab-cli/`, `plantlab-core/`,
`plantlab-web/`, `plantlab-agent/`, `plantlab-shared/`) was evaluated, since
it's a reasonable shape for where this platform is eventually headed. It
was **not** adopted now, for concrete reasons specific to this codebase's
current state rather than a general aversion to monorepos:

1. **This is a live, already-deployed production app**, not a greenfield
   project. Prior tasks in this repository's history installed real
   systemd user units on a real machine, pointing at this exact directory
   layout (`WorkingDirectory=<repo>`, `ExecStart=... run start`). Moving
   `src/app` into `packages/plantlab-web/` would require rewriting the
   Next.js build output location, every systemd unit template, path
   resolution assumptions in `src/lib/paths.server.ts` (which anchors on
   `process.cwd()`/`PLANTLAB_ROOT_DIR`), `tsconfig.json`'s `@/*` path alias,
   `vitest.config.ts`, and `DEPLOYMENT.md` in its entirety - a large,
   high-blast-radius change with real risk of breaking the working
   deployment, in exchange for organizational benefit that doesn't yet
   exist: there is currently exactly one runtime shape (the Next.js app,
   plus one long-running non-Next.js script, `camera-service.ts`), not
   several independently-versioned, independently-deployed packages that
   would benefit from separate `package.json`s.
2. **No real duplication exists yet that a package boundary would prevent.**
   The actual duplication this task needed to remove (doctor logic
   scattered across a script and a hypothetical future CLI, ad hoc backup
   handling) is removed by introducing `src/lib/operations/` as a shared
   layer *within* the existing package - a package boundary isn't what was
   creating the duplication, so it isn't needed to remove it.
3. **A monorepo pays off once there is a second genuinely independent
   runtime** - most plausibly `plantlab-agent`, once a real capture-agent
   protocol needs to run on a Raspberry Pi with a different dependency
   footprint than the web app (no Next.js, no Sharp/native image
   processing needed there, etc.). That work is explicitly out of scope
   for this task. **Revisit this decision when that work begins** - at
   that point, extracting the agent into its own package (with `plantlab-core`
   holding whatever it needs from `src/lib/`) is a much smaller, better-
   motivated move than extracting everything speculatively now.

Instead, this task organizes the codebase *within* the single package:

```
bin/plantlab              # launcher: spawns tsx against src/cli/index.ts
src/cli/                  # CLI command definitions (thin - see below)
  commands/*.ts
  index.ts                # commander program setup
  format.ts                # shared terminal-output formatting
  sshConfig.ts              # ~/.ssh/config reader (used by `node discover`)
src/lib/                  # unchanged - existing domain logic
  operations/              # NEW: shared orchestration layer (see below)
    config.ts               # node role config (plantlab.config.json)
    doctor.ts                # unified health-check report
    install.ts               # install workflow orchestration
  backup.ts                 # extended in place (checksums, manifests, destinations)
  projectLifecycle.ts        # NEW: lifecycle state constants + validation
src/app/api/health/route.ts # NEW: JSON form of the same doctor report
```

`src/lib/operations/` holds orchestration - functions that combine several
existing `src/lib/*.ts` modules into one report or workflow (`doctor.ts`,
`install.ts`) or a small new concern with no other home (`config.ts`,
`projectLifecycle.ts`). It does **not** contain a wholesale relocation of
existing, already-tested modules (`startupChecks.ts`, `dataDoctor.server.ts`,
`serviceStatus.ts`, `v4l2.ts`, `camera.ts`, ...) - those stay exactly where
they are and are simply *consumed* by the new operations layer. Moving
already-correct, already-imported, already-tested files carries real risk
(missed import updates, test breakage) for no functional benefit when the
actual goal - one shared implementation instead of two - is achieved just
by adding the orchestration layer on top. This matches the task's own
instruction: move code only where it improves ownership and removes
duplication, not for its own sake.

## PlantLab CLI

`bin/plantlab` is a thin Node launcher that spawns `tsx` against
`src/cli/index.ts` - the same `tsx`-not-a-compiled-build approach every
other operational script in this repo already uses (see `DEPLOYMENT.md`
"Why `tsx` and not a compiled build"), applied consistently rather than
introducing a second tooling convention just for the CLI.

`src/cli/index.ts` builds a [commander](https://github.com/tj/commander.js)
program and registers one module per top-level command
(`src/cli/commands/*.ts`). Every command handler is intentionally thin: it
parses CLI-specific input (flags, interactive prompts) and prints
CLI-specific output, then delegates the actual work to `src/lib/` (mostly
`src/lib/operations/`). No command handler contains business logic that
isn't reused from somewhere.

**Why this matters for "one implementation, not two":** `plantlab doctor`
and `GET /api/health` both call `runDoctorReport()` from
`src/lib/operations/doctor.ts` and only differ in how they render the
result (terminal text vs. JSON). Adding a health check means editing one
function; both surfaces pick it up automatically.

## Backup architecture

See `DEPLOYMENT.md` "Backups" for the operational summary. The design
principle: **the on-disk archive format is never allowed to become a
breaking change.** A `.tar.gz` created by any version of `createBackup()`,
past or future, must remain extractable by an unmodified `tar -xzf`, and
every new field added to `manifest.json` must be optional so an old backup
is still a valid (partial) manifest. The `BackupDestination` interface
exists so a future non-local destination is an additive change (implement
the interface, wire it into `createBackup()`'s destination selection) - it
is not implemented for any actual remote target in this task, only for the
local filesystem (`LocalFilesystemDestination`), which is what already
happened before this task, now behind a named abstraction.

`restoreBackup()` is deliberately extract-only, never a live in-place swap
- see `DEPLOYMENT.md` "Backups" for why. This is a direct consequence of
this task's "no destructive migration, no automatic cleanup of user data"
safety requirement: an automatic live restore would be exactly that kind
of destructive operation.

## Project lifecycle

`Project.lifecycleState` is metadata only in this task - see
`DEPLOYMENT.md` "Project lifecycle". It exists now, ahead of the actual
backup/publication/archival workflows that will consume it, so that work
doesn't have to invent a state model under time pressure later. Every
existing project migrates with `lifecycleState: null`, treated identically
to `ACTIVE` everywhere - this is intentionally the *only* safe way to add
lifecycle metadata to projects that predate the concept: anything that
picked a non-null default, or that changed any read path's behavior based
on the new field, would risk a real (if subtle) behavior change for
existing data, which this task's safety requirements forbid.

## Roles

`plantlab install` records one of `coordinator` / `camera-node` /
`standalone` / `microscope-node` / `mobile-uploader` / `greenhouse-node` in
`plantlab.config.json`. Role now determines which systemd services are
expected to run (`src/lib/operations/serviceRoles.ts`) and which agent
runtime a node uses - see `DEPLOYMENT.md` "Canonical role-convergence
design" and "Lightweight edge agent". `greenhouse-node` exists as a
capability-agnostic role (see `src/lib/operations/capabilities.ts`): a
greenhouse-node behaves identically to a camera-node today
(camera-capability only) and will grow sensor/relay behavior by reading
reported capabilities rather than by branching on this role name.

## Explicitly out of scope (deferred, not forgotten)

Per this task's own scope boundary:

- The capture-agent scheduler, heartbeat, and job protocol. `plantlab node`/
  `camera` commands establish the CLI surface only - they inspect local
  state (v4l2 hardware, `~/.ssh/config`) and print guidance; they do not
  register, schedule, or communicate with any remote node.
- Remote backup destinations (external SSD, remote coordinator, NAS,
  cloud) - only the `BackupDestination` interface and its local
  implementation exist.
- A `packages/` monorepo split - see "Repository organization" above for
  the reconsideration trigger.
- PostgreSQL, Supabase, Docker deployment, a public website, archive
  storage movement (a project's files are never moved when its lifecycle
  state changes), camera auto-registration, distributed scheduling, mobile
  applications.

## What changed vs. what stayed the same

- **New**: `bin/plantlab`, `src/cli/**`, `src/lib/operations/**`,
  `src/lib/projectLifecycle.ts`, `src/app/api/health/route.ts`,
  `Project.lifecycleState` (additive migration), backup checksums/manifest
  v2/sidecar/destinations/verify/restore.
- **Extended in place** (not moved, not duplicated): `src/lib/backup.ts`.
- **Removed** (logic fully absorbed by the CLI + operations layer, nothing
  lost): `scripts/doctor.ts`, `scripts/dataDoctor.ts`, `scripts/backup.ts`.
- **Unchanged**: everything else - `src/lib/startupChecks.ts`,
  `src/lib/dataDoctor.server.ts`, `src/lib/serviceStatus.ts`, the camera
  capture pipeline, the ingest endpoint, `scripts/camera-*.ts`,
  `deploy/systemd/*`, the database schema apart from the one additive
  column, and every existing project's data.
