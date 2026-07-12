# Development

Use the installer for normal application setup. For code development:

```bash
pnpm install
pnpm db:generate
pnpm db:push
pnpm dev
```

## Checks

```bash
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm build
```

## CLI

During development, run the local launcher:

```bash
bin/plantlab --help
bin/plantlab doctor
```

The installer creates a global `plantlab` command for normal use.

## Data Safety

- `.env`, SQLite databases, generated media, backups, and local data
  directories are ignored by git.
- Tests use isolated temporary SQLite databases and temporary filesystems.
- Do not run development and production Next.js processes against the same
  checkout at the same time.
