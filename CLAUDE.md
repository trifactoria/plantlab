# CLAUDE.md

Read and follow `AGENTS.md` before making changes. `AGENTS.md` contains the repository-wide engineering, validation, security, and branch rules.

## Claude-specific operating instructions

Before starting work:

1. Run `git status`.
2. Print the current branch.
3. Pull the latest remote changes without rewriting history.
4. Confirm the task belongs on `dev` or on a feature branch based on `AGENTS.md`.
5. Inspect existing implementations before creating new abstractions.

During work:

- Make the smallest coherent change that fully addresses the task.
- Preserve unrelated user changes.
- Reuse existing patterns where they are sound.
- Refactor duplication when it directly affects the requested feature.
- Keep a short running checklist for multi-step tasks.
- Do not claim a check passed unless you actually ran it.
- Do not leave the repository in a knowingly broken state.

## Required end-of-task Git workflow

Unless the user explicitly asks for analysis only, a plan only, or no repository changes:

1. Review `git diff`.
2. Run the required checks from `AGENTS.md`.
3. Commit all and only the intended task changes.
4. Push the completed commit to GitHub.
5. Normally push to `dev`.
6. Push or merge to `main` only when the user explicitly authorizes a production release.
7. Report the branch, commit hash, pushed remote, checks run, and remaining concerns.

Do not stop after editing files. Do not leave completed work uncommitted or only local when GitHub access is available.

If the push is rejected:

- Do not force-push.
- Fetch the remote.
- Explain the divergence.
- Rebase or merge only when it is safe and does not overwrite user work.
- If credentials or permissions prevent pushing, preserve the local commit and report the exact command failure.

## PlantLab product direction

PlantLab is evolving from a plant-only tracker into a local-first biological project and time-series observation platform.

Near-term priorities:

- simplify repeated specimen creation
- unify events, milestones, and structured results through an observation workflow
- create profile-style specimen pages with tabs
- improve mobile field capture
- add owner authentication
- support read-only public projects
- preserve private-by-default behavior
- generate individual specimen and project time-lapse views

Public sharing must remain intentionally simple:

- no comments
- no social feed
- no public editing
- no public account requirement initially
- only explicitly published projects and media are visible

## Decision rule

When implementation choices conflict, prioritize in this order:

1. User data safety
2. Authorization and privacy
3. Reliable common workflows
4. Maintainability and reuse
5. Mobile usability
6. Advanced or speculative features
