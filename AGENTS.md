# AGENTS.md

## Project

PlantLab is a local-first experiment tracking platform for biological projects that change over time, including plant growth, selective breeding, mycology, tissue culture, microscopy, and field specimens.

The application currently uses Next.js, React, TypeScript, Prisma, SQLite, Tailwind CSS, Vitest, and Playwright.

## Instruction scope

This file applies to the entire repository.

More specific `AGENTS.md` files may be added inside subdirectories when a subsystem needs additional rules. A nested file supplements or overrides this root file for files beneath that directory.

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

## Completion and push requirements

A coding task is not complete until the agent has:

1. Reviewed the final diff.
2. Run the relevant validation commands.
3. Committed the intended changes with a descriptive commit message.
4. Pushed the commit to the appropriate GitHub branch.
5. Reported:
   - branch name
   - commit hash
   - tests and checks run
   - any known limitations or follow-up work

If pushing fails because credentials, permissions, connectivity, or repository state prevent it, state the exact failure and leave the local commit intact. Never claim that changes were pushed when they were not.

## Required validation

Run the checks appropriate to the changed code. For application-wide changes, run all of the following:

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

For screenshot or visual changes, also run:

```bash
npm run screenshots
```

Do not silently skip failed checks. Diagnose and fix failures caused by the task. Clearly report unrelated pre-existing failures.

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

Prefer:

- reusable components
- one canonical observation workflow
- responsive layouts
- large mobile tap targets
- progressive disclosure
- sensible defaults
- batch entry
- keyboard-friendly desktop workflows

Avoid:

- duplicated forms and mutation logic
- page-specific versions of the same component
- overlapping concepts with unclear differences
- exposing internal database terminology unnecessarily
- giant all-in-one detail pages

## Architecture expectations

- Reuse shared components for repeated controls and workflows.
- Keep server authorization close to data access and mutations.
- Validate all mutation input on the server.
- Do not trust client-provided project visibility, ownership, role, or subject identifiers without authorization checks.
- Prefer small, reviewable migrations.
- Add tests for bug fixes and behavior changes.
- Keep routes and components understandable rather than prematurely abstract.
- Use structured database fields for common searchable concepts. Do not move everything into JSON.

## Security

- Never commit secrets, passwords, API keys, private URLs, database files, uploaded photos, or environment-specific credentials.
- Keep `.env*`, SQLite databases, backups, generated media, and local photo directories ignored unless an example file is intentionally committed.
- Public routes must filter at the database query layer to records explicitly marked public.
- Mutation endpoints must require an authenticated owner or authorized editor.
- Treat photo metadata and collection locations as potentially sensitive.
- Do not expose precise field-collection locations publicly by default.

## Git hygiene

- Keep commits focused.
- Use descriptive commit messages.
- Do not include generated screenshots, databases, backups, or local runtime files unless the task explicitly requires fixtures.
- Update documentation when behavior, setup, commands, environment variables, or architecture changes.
