## Project

PlantLab is a local-first experiment tracking and automation platform for biological projects that change over time, including plant growth, selective breeding, mycology, tissue culture, microscopy, greenhouse monitoring, cameras, environmental sensors, and controlled power outlets.

The application currently uses Next.js, React, TypeScript, Prisma, SQLite, Tailwind CSS, Vitest, Playwright, and a lightweight Python edge agent for low-resource Raspberry Pi nodes.

## Hardware product contract

PlantLab is currently a trusted home-lab system. Do not add security, authorization, public-hosting, or multi-tenant restrictions unless the user explicitly requests that work.

Coordinator and every attached node may own cameras and sensors. All configured fleet hardware must remain visible, manageable, configurable, testable, schedulable, and usable from the coordinator UI.

Local versus remote changes execution routing only: local hardware executes locally, and attached hardware executes through its node agent. It must not determine whether the user can manage hardware.

User-defined values always override hardware reports. Display names, labels, selected camera modes, schedules, warm-up, retry, fallback, assignments, placement, GPIO configuration, and project-specific labels are user-owned unless a later design explicitly says otherwise.

Inventory may update reported names, endpoints, device paths, USB evidence, capabilities, supported formats, availability, and last-seen timestamps. Inventory must never overwrite user-owned fields.

Camera quality may not be silently downgraded persistently. Temporary fallback for one capture must be reported separately from the configured primary mode.

Transient DHT22 misses are normal. One failed or rejected sample must not immediately become a sustained Failed health state; use the canonical sensor-health evaluator.

Reuse canonical fleet hardware APIs and shared picker/card/drawer/detail contracts. Do not create new page-specific selectors or configuration forms when a canonical reusable component or API exists.

## Instruction scope

This file applies to the entire repository.

More specific `AGENTS.md` files may be added inside subdirectories when a subsystem needs additional rules. A nested file supplements or overrides this root file for files beneath that directory.

## Deployment topology

The development environment has SSH aliases configured in `~/.ssh/config`.

These names are operational host aliases and may be used directly with `ssh`, `scp`, and the repository's existing deployment commands:

| SSH alias | Role | Purpose |
|---|---|---|
| `xps` | standalone PlantLab installation and primary development machine | Development, local testing, and a standalone PlantLab instance containing real user data |
| `plantlab` | coordinator | Authoritative coordinator web application, database, schedules, command queue, and node registry |
| `bokchoy` | camera node | Remote camera agent |
| `greenhouse-zero` | greenhouse node | Lightweight Python edge agent controlling Kasa power, four DHT22 sensors, and three cameras |

Do not assume that the machine running the current shell is the same machine as any of these aliases. Confirm the local hostname and PlantLab role before operating.

Useful non-destructive probes include:

```bash
hostname
git status
git branch --show-current
bin/plantlab node info
ssh xps 'hostname'
ssh plantlab 'hostname'
ssh bokchoy 'hostname'
ssh greenhouse-zero 'hostname'
````

Agents may inspect these hosts when the task involves live behavior, deployment, service state, hardware, coordinator state, or data-path verification.

Prefer gathering live evidence directly rather than asking the user to copy routine logs or command output, provided the required SSH access is available.

## Live data and destructive-operation policy

`xps` and `plantlab` contain real, persistent PlantLab data.

Treat both installations as production-like data stores even when working on the `dev` branch.

Never perform any of the following without explicit user authorization and a clear backup/recovery plan:

- delete, recreate, reset, or replace a live SQLite database;
    
- run destructive Prisma reset commands;
    
- use `prisma migrate reset`;
    
- remove migration history;
    
- delete projects, observations, specimens, sensor history, schedules, cameras, nodes, credentials, photos, or uploaded media;
    
- replace a live data directory with fixtures or test data;
    
- point a live service at a temporary or test database;
    
- run tests against a live database when the tests may write, truncate, migrate, or delete data;
    
- discard a database because migrations appear inconsistent;
    
- erase durable edge-agent spool, configuration, or credential directories;
    
- reinstall a node in a way that loses its existing configuration.
    

Before schema or migration work:

1. Identify the exact database used by the running process.
    
2. Do not infer the runtime database path solely from a relative `DATABASE_URL`.
    
3. Inspect the active service environment and resolved paths.
    
4. Confirm the migration is additive or otherwise preserves existing data.
    
5. Make a backup before any migration with meaningful risk.
    
6. Use an isolated temporary database for automated tests and destructive migration experiments.
    

If a migration is partially applied, repair or resolve it non-destructively. Do not reset the database merely to make migration tooling happy.

Historical records should normally be preserved. Hide obsolete records from active UI views when appropriate rather than deleting history without authorization.

## Branch workflow

- `main` is the deployable production branch.
    
- `dev` is the normal integration and development branch.
    
- Start normal work from an up-to-date `dev` branch.
    
- For small, focused tasks, commits may be made directly to `dev`.
    
- For risky, broad, or multi-day work, create a short-lived feature branch from `dev`.
    
- Do not push directly to `main` unless the user explicitly says to release, deploy, merge, or push to `main`.
    
- Never force-push `main` or `dev`.
    
- Never rewrite published history.
    
- Before editing, run `git status` and inspect the active branch.
    
- Do not discard or overwrite unrelated user changes.
    

## Repository and host responsibilities

The repository checkout on the development machine is the source of truth for code changes.

Do not develop by directly editing installed runtime files on remote hosts.

In particular, do not manually edit files under paths such as:

```text
~/.local/share/plantlab-edge-agent
~/plantlab-edge-agent
```

on `greenhouse-zero`.

The lightweight edge-agent source lives in the repository under:

```text
edge-agent/
```

Use the authoritative attach workflow to deploy it:

```bash
bin/plantlab node attach greenhouse-zero --yes
```

That flow copies and installs the edge agent while preserving durable configuration, credentials, and spool data.

Use existing PlantLab service and deployment workflows for `plantlab`, `bokchoy`, and `xps`. Do not invent a parallel deployment mechanism unless the existing architecture is demonstrably insufficient and the user approves the change.

## Live inspection and verification

When a task concerns a live node or coordinator behavior, inspect the relevant host before guessing.

Examples:

```bash
ssh plantlab 'systemctl --user status plantlab-web.service --no-pager -l'
ssh plantlab 'systemctl --user status plantlab-camera.service --no-pager -l'
ssh greenhouse-zero 'systemctl --user status plantlab-edge-agent.service --no-pager -l'
ssh greenhouse-zero 'bash -lc "plantlab-edge doctor"'
ssh greenhouse-zero 'bash -lc "plantlab-edge config show"'
ssh greenhouse-zero 'bash -lc "plantlab-edge power status"'
```

Live probing should be non-destructive by default.

Read-only inspection, status requests, logs, API GET requests, and bounded diagnostic tests are normally acceptable.

Actions that change physical hardware state require care:

- restore fans and lights to their prior state after a temporary test;
    
- do not issue water or pump commands unless the user explicitly requests them and connected hardware is understood;
    
- avoid rapid power cycling;
    
- do not alter GPIO assignments without confirming the physical wiring;
    
- do not expose arbitrary remote shell execution through the web application.
    

When performing a real timer or power test, record the initial state and restore it afterward unless the user requested a new final state.

## Service and database path verification

Do not assume that a repository-local `.env`, Prisma CLI invocation, Next.js runtime, or systemd service resolves a relative SQLite path the same way.

Before touching live data, determine:

- the running service unit;
    
- environment files and overrides;
    
- `DATABASE_URL`;
    
- the absolute database path used by the running process;
    
- PlantLab's resolved data, config, media, spool, and runtime paths.
    

Machine-local `.env.local` or equivalent overrides must remain ignored and must never be committed.

## Completion and push requirements

A coding task is not complete until the agent has:

1. Reviewed the final diff.
    
2. Run the relevant validation commands.
    
3. Committed the intended changes with a descriptive commit message.
    
4. Pushed the commit to the appropriate GitHub branch.
    
5. Reported:
    
    - branch name;
        
    - commit hash;
        
    - tests and checks run;
        
    - deployment actions;
        
    - live verification performed;
        
    - final hardware state when relevant;
        
    - any known limitations or follow-up work.
        

If pushing fails because credentials, permissions, connectivity, or repository state prevent it, state the exact failure and leave the local commit intact. Never claim that changes were pushed when they were not.

## Required validation

Run checks appropriate to the changed code.

For application-wide changes, run:

```bash
pnpm typecheck
pnpm test:unit
pnpm build
```

Run Playwright tests relevant to the changed workflows:

```bash
pnpm test:e2e
```

For screenshot or visual changes, also run:

```bash
pnpm screenshots
```

For Python edge-agent changes, run:

```bash
python3 -m pytest edge-agent/tests
```

Use the package manager already established by the repository. Do not introduce mixed lockfile changes casually.

Do not silently skip failed checks. Diagnose and fix failures caused by the task. Clearly report unrelated pre-existing failures.

Automated tests must use isolated test data and must not mutate the live `xps` or `plantlab` databases.

## Product and domain rules

- The product must gradually broaden beyond plants to support specimens, cultures, samples, batches, and other tracked subjects.
    
- Prefer user-facing terms such as `specimen`, `subject`, or project-configured labels when working on generalized interfaces.
    
- Do not perform a large `Plant`-to-`Subject` database rename casually. Use compatibility layers and staged migrations.
    
- Preserve existing user data.
    
- Avoid destructive Prisma schema changes unless a migration and backup strategy are included.
    
- Keep the application local-first.
    
- Keep private project data private by default.
    
- Public viewing must be read-only.
    
- Public viewers must never receive mutation controls or access to private projects.
    
- Authentication and authorization must be enforced on the server, not only hidden in the UI.
    
- Coordinator-to-node actions should use structured authenticated protocols, not arbitrary remote shell commands.
    
- Hardware state shown in the UI must distinguish requested state from observed actual state.
    
- Sensor failures must remain isolated so one bad sensor does not block valid telemetry from others.
    
- Diagnostic history should be preserved separately from accepted measurements.
    

## UX priorities

Optimize common real-world workflows before adding optional complexity.

Important workflows include:

- Adding multiple specimens in sequence
    
- Reusing the previous timestamp and observation while entering a batch
    
- Incrementing names such as `R1` to `R2`
    
- Recording an observation quickly from a phone
    
- Adding photos from field work
    
- Viewing a specimen as a profile rather than a wall of forms
    
- Sharing selected project timelines publicly in read-only mode
    
- Monitoring nodes, cameras, sensors, and power from the coordinator
    
- Diagnosing hardware without requiring routine SSH use
    
- Understanding stale, failed, pending, and observed states clearly
    

Prefer:

- reusable components;
    
- one canonical observation workflow;
    
- responsive layouts;
    
- large mobile tap targets;
    
- progressive disclosure;
    
- sensible defaults;
    
- batch entry;
    
- keyboard-friendly desktop workflows;
    
- concise overview pages with links to detailed diagnostics;
    
- explicit operator guidance for recoverable failures.
    

Avoid:

- duplicated forms and mutation logic;
    
- page-specific versions of the same component;
    
- overlapping concepts with unclear differences;
    
- exposing internal database terminology unnecessarily;
    
- giant all-in-one detail pages;
    
- optimistic hardware state that has not been observed;
    
- hiding failures behind generic “healthy” status.
    

## Architecture expectations

- Reuse shared components for repeated controls and workflows.
    
- Keep server authorization close to data access and mutations.
    
- Validate all mutation input on the server.
    
- Do not trust client-provided project visibility, ownership, role, or subject identifiers without authorization checks.
    
- Prefer small, reviewable migrations.
    
- Add tests for bug fixes and behavior changes.
    
- Keep routes and components understandable rather than prematurely abstract.
    
- Use structured database fields for common searchable concepts. Do not move everything into JSON.
    
- Keep the coordinator as the control plane for schedules and node commands.
    
- Edge agents should report observed results back to the coordinator.
    
- Long-running or hardware operations must have bounded timeouts.
    
- One failed subsystem must not indefinitely block heartbeats, command handling, sensors, cameras, or power reporting.
    
- Preserve durable queues and diagnostic records across service restarts.
    
- Avoid adding a new daemon when an existing long-running service is the appropriate owner, but do not overload a process without considering failure isolation.
    

## Security

- Never commit secrets, passwords, API keys, private URLs, database files, uploaded photos, or environment-specific credentials.
    
- Keep `.env*`, SQLite databases, backups, generated media, and local photo directories ignored unless an example file is intentionally committed.
    
- SSH host aliases may be documented, but never commit private keys, passwords, IP-specific secrets, or the contents of private credential files.
    
- Public routes must filter at the database query layer to records explicitly marked public.
    
- Mutation endpoints must require an authenticated owner or authorized editor.
    
- Treat photo metadata and collection locations as potentially sensitive.
    
- Do not expose precise field-collection locations publicly by default.
    
- Do not expose arbitrary SSH or shell execution through browser routes.
    
- Do not log Kasa credentials, node credentials, access tokens, or secret environment values.
    

## Git hygiene

- Keep commits focused.
    
- Use descriptive commit messages.
    
- Do not include generated screenshots, databases, backups, test artifacts, credentials, or local runtime files unless the task explicitly requires safe fixtures.
    
- Update documentation when behavior, setup, commands, environment variables, host topology, or architecture changes.
