Read and follow `AGENTS.md` before making changes. `AGENTS.md` contains the repository-wide engineering, validation, security, branch, live-data, deployment, and host-operation rules.

## Hardware architecture guidance

For camera and sensor work, follow the current hardware product contract:

- PlantLab is a trusted home-lab system unless the user explicitly scopes security, public-hosting, authorization, or multi-tenant work.
- Coordinator and every node may own cameras and sensors.
- All configured fleet hardware remains manageable through the coordinator.
- Local versus remote changes execution routing only.
- User-defined names, labels, modes, schedules, placement, GPIO configuration, and other configuration values override hardware reports.
- Inventory updates reported hardware state only and must not overwrite user-owned fields.
- Camera fallback must not silently replace the configured primary mode.
- Transient DHT22 misses are not immediate sustained failures; use the canonical health evaluator.
- Reuse canonical fleet hardware APIs and shared hardware UI contracts instead of creating new selectors or forms.

## Claude-specific operating instructions

Before starting work:

1. Run `git status`.
2. Print the current branch.
3. Print the local hostname.
4. Inspect the configured PlantLab role and resolved paths when relevant.
5. Pull the latest remote changes without rewriting history.
6. Confirm the task belongs on `dev` or on a feature branch based on `AGENTS.md`.
7. Inspect existing implementations before creating new abstractions.
8. Identify whether the task concerns local development, the standalone installation, the coordinator, a camera node, or the greenhouse node.
9. Check for unrelated work already in progress and do not overwrite it.

Useful commands:

```bash
hostname
git status
git branch --show-current
bin/plantlab node info
````

## Known SSH hosts

The following aliases are configured in `~/.ssh/config` and may be probed directly:

|Alias|PlantLab role|Notes|
|---|---|---|
|`xps`|standalone|Primary development machine and standalone PlantLab installation with real data|
|`plantlab`|coordinator|Live coordinator web service, database, schedules, command queue, and node registry|
|`bokchoy`|camera-node|Remote camera agent|
|`greenhouse-zero`|greenhouse-node|Python edge agent with Kasa power, four DHT22 sensors, and three cameras|

Use these aliases directly:

```bash
ssh xps
ssh plantlab
ssh bokchoy
ssh greenhouse-zero
```

When investigating a live problem, gather routine evidence directly through SSH instead of asking the user to copy logs, provided access works.

Do not assume that the local shell is running on `xps`. Confirm with `hostname`.

## Live data safety

`xps` and `plantlab` contain real persistent data.

Treat both as production-like.

Never reset, recreate, replace, truncate, or repoint their databases merely to make a test or migration pass.

Do not run destructive commands such as:

```bash
prisma migrate reset
rm prisma/dev.db
rm -rf <live-data-directory>
```

Do not run automated tests against a live database when those tests may mutate data.

Before database work:

1. Identify the exact absolute database path used by the running process.
    
2. Inspect systemd service environment and machine-local overrides.
    
3. Do not trust relative SQLite path resolution.
    
4. Use an isolated temporary database for tests.
    
5. Back up live data before meaningful migration risk.
    
6. Prefer additive, non-destructive migrations.
    
7. Preserve historical data unless the user explicitly authorizes deletion.
    

If migration state is inconsistent, repair it non-destructively rather than resetting the database.

## Host inspection

When relevant, inspect live service state.

Coordinator:

```bash
ssh plantlab 'systemctl --user status plantlab-web.service --no-pager -l'
ssh plantlab 'systemctl --user status plantlab-camera.service --no-pager -l'
```

Camera node:

```bash
ssh bokchoy 'systemctl --user status plantlab-agent.service --no-pager -l'
```

Greenhouse node:

```bash
ssh greenhouse-zero 'systemctl --user status plantlab-edge-agent.service --no-pager -l'
ssh greenhouse-zero 'bash -lc "plantlab-edge doctor"'
ssh greenhouse-zero 'bash -lc "plantlab-edge config show"'
ssh greenhouse-zero 'bash -lc "plantlab-edge power status"'
```

Use read-only probes and logs first.

Do not restart services reflexively before collecting evidence, because restarting can erase the state needed to diagnose an intermittent problem.

## Development and deployment boundaries

Make source changes in the repository checkout, not inside installed remote runtime directories.

Do not manually edit these paths on `greenhouse-zero`:

```text
~/.local/share/plantlab-edge-agent
~/plantlab-edge-agent
```

The repository's `edge-agent/` directory is the source of truth.

Deploy edge-agent changes through:

```bash
bin/plantlab node attach greenhouse-zero --yes
```

Use the repository's established service, install, update, and attach workflows for other hosts.

Do not invent an alternate SCP, curl-pipe-shell, Docker, or manual install process unless the existing path cannot support the requested behavior and the user approves the architecture change.

## Hardware safety

`greenhouse-zero` controls physical devices.

Currently:

- `fans` controls greenhouse airflow;
    
- `lights` controls greenhouse lighting;
    
- `water` is reserved for future irrigation and does not currently have an active watering system;
    
- four DHT22 sensors monitor outside, bottom, middle, and top positions;
    
- three cameras are attached.
    

When testing:

- record the initial fan and light states;
    
- avoid rapid power cycling;
    
- restore the prior state after temporary tests unless the user asks for a new final state;
    
- do not issue water or pump actions unless explicitly requested;
    
- do not change GPIO assignments without confirming physical wiring;
    
- do not treat a queued command as successful until actual state is observed;
    
- use bounded attempts and timeouts;
    
- keep sensor, heartbeat, camera, and command processing isolated from one another.
    

## During work

- Make the smallest coherent change that fully addresses the task.
    
- Preserve unrelated user changes.
    
- Reuse existing patterns where they are sound.
    
- Refactor duplication when it directly affects the requested feature.
    
- Keep a short running checklist for multi-step tasks.
    
- Do not claim a check passed unless you actually ran it.
    
- Do not leave the repository in a knowingly broken state.
    
- Inspect live behavior when the requested fix concerns live behavior.
    
- Distinguish source-code defects, deployment defects, configuration defects, database-path defects, network defects, and physical hardware defects.
    
- Do not guess about live state when it can be probed safely.
    
- Do not conceal known failures behind optimistic UI.
    
- Avoid asking the user to perform routine commands that you can run through the configured SSH hosts.
    

## Operational diagnostics

For intermittent issues, trace the full lifecycle rather than inspecting only one layer.

Examples:

### Power

```text
schedule due
→ command created
→ command offered
→ command claimed
→ edge execution
→ Kasa state refreshed
→ completion uploaded
→ observed state displayed
```

### Sensors

```text
configured sensor
→ edge read attempt
→ classification
→ spool
→ coordinator ingestion
→ accepted reading or diagnostic
→ dashboard state
```

### Cameras

```text
inventory/configuration
→ capture request
→ node execution
→ upload/spool
→ coordinator persistence
→ UI display
```

Collect timestamps and IDs that let latency and failures be correlated across hosts.

## Required end-of-task Git workflow

Unless the user explicitly asks for analysis only, a plan only, or no repository changes:

1. Review `git diff`.
    
2. Run the required checks from `AGENTS.md`.
    
3. Commit all and only the intended task changes.
    
4. Push the completed commit to GitHub.
    
5. Normally push to `dev`.
    
6. Push or merge to `main` only when the user explicitly authorizes a production release.
    
7. Report:
    
    - branch;
        
    - commit hash;
        
    - pushed remote;
        
    - checks run;
        
    - migrations;
        
    - deployment commands;
        
    - live hosts inspected;
        
    - live verification results;
        
    - final fan/light state when touched;
        
    - remaining concerns.
        

Do not stop after editing files. Do not leave completed work uncommitted or only local when GitHub access is available.

If the push is rejected:

- Do not force-push.
    
- Fetch the remote.
    
- Explain the divergence.
    
- Rebase or merge only when it is safe and does not overwrite user work.
    
- If credentials or permissions prevent pushing, preserve the local commit and report the exact command failure.
    

## PlantLab product direction

PlantLab is evolving from a plant-only tracker into a local-first biological project, time-series observation, distributed camera, greenhouse monitoring, and automation platform.

Near-term priorities:

- simplify repeated specimen creation;
    
- unify events, milestones, and structured results through an observation workflow;
    
- create profile-style specimen pages with tabs;
    
- improve mobile field capture;
    
- add owner authentication;
    
- support read-only public projects;
    
- preserve private-by-default behavior;
    
- generate individual specimen and project time-lapse views;
    
- make coordinator nodes, cameras, sensors, power, schedules, and diagnostics easy to operate from the browser;
    
- reduce routine SSH and CLI troubleshooting without exposing arbitrary remote shell execution;
    
- preserve reliable observed-state semantics for physical hardware.
    

Public sharing must remain intentionally simple:

- no comments;
    
- no social feed;
    
- no public editing;
    
- no public account requirement initially;
    
- only explicitly published projects and media are visible.
    

## Decision rule

When implementation choices conflict, prioritize in this order:

1. User data safety
    
2. Physical hardware safety
    
3. Authorization and privacy
    
4. Reliable common workflows
    
5. Clear diagnostics and recoverability
    
6. Maintainability and reuse
    
7. Mobile usability
    
8. Advanced or speculative features
