# Installation

The supported installation path is:

```bash
git clone https://github.com/trifactoria/plantlab.git
cd plantlab
./install.sh
```

The installer:

- verifies Node.js 22 or newer
- enables or verifies `pnpm`
- installs project dependencies
- creates `.env` from `.env.example` when needed
- prepares a new local SQLite schema when no database exists yet
- builds the production app
- installs the `plantlab` command into `/usr/local/bin`
- runs `plantlab install` for role configuration
- runs `plantlab doctor`

## Re-running

`./install.sh` is safe to run again. It reuses existing dependencies,
configuration, builds, and CLI links where possible.

If a `plantlab` command already exists and points somewhere else, the
installer asks before updating it.

## Useful Options

```bash
./install.sh --verbose
./install.sh --role standalone
./install.sh --role coordinator
./install.sh --role camera-node --coordinator-url http://plantlab:3000
./install.sh --skip-systemd
```

## After Installation

```bash
plantlab doctor
plantlab --help
plantlab camera list
plantlab backup list
```

`./install.sh` bootstraps the local checkout. `plantlab install` performs
deliberate local role setup or local role changes. Use
`plantlab node attach <host>` from a coordinator to enroll or convert a
remote camera node, and use `plantlab doctor --fix` for guided repair.

## Upgrading (already-installed machine)

```bash
git pull
plantlab update
```

`plantlab update` is the canonical upgrade path - not `./install.sh`
again. It installs dependencies, regenerates the Prisma client, applies
any pending database migrations (with a backup first, for a role that
owns the canonical database), rebuilds, and restarts the services expected
for this machine's configured role. It never runs `git pull` itself and
never touches services or the database for roles that don't need it (a
camera-node update never starts web/camera or migrates the domain
database).
