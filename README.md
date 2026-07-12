# PlantLab

PlantLab is a local-first experiment tracking platform for biological
projects that change over time: plant growth, selective breeding, mycology,
tissue culture, microscopy, and field specimens.

It keeps project records, observations, timelines, photos, camera captures,
and backups on machines you control.

## Features

- Local-first project tracking with SQLite and filesystem photo storage
- Plant/specimen records, observations, milestones, and timelines
- Local camera discovery, preview, capture, and shared capture sources
- Coordinator and camera-node workflow for cross-machine image capture
- HTTP-based agent ingest with idempotent retries
- Backup creation, verification, and safe restore staging
- Operational CLI: `plantlab`

## Requirements

- Ubuntu or another Linux system with systemd user services
- Git
- Node.js 22 or newer

The installer enables `pnpm` with Corepack when possible.

## Installation

```bash
git clone https://github.com/trifactoria/plantlab.git
cd plantlab
./install.sh
```

The installer checks dependencies, installs project packages, prepares a new
local database when needed, builds PlantLab, installs the `plantlab` command,
and then runs the interactive setup.

After installation:

```bash
plantlab doctor
```

works from any directory.

## Basic Usage

```bash
plantlab --help
plantlab doctor
plantlab camera list
plantlab backup list
```

For a coordinator with a separate camera node:

```bash
plantlab node inspect xps
plantlab node attach xps
plantlab camera list --node xps
plantlab camera attach --node xps
plantlab capture test --node xps
```

## CLI Overview

- `plantlab install` - configure this machine as standalone, coordinator, or camera node
- `plantlab doctor` - check health and show next actions
- `plantlab camera` - list, attach, and test cameras
- `plantlab node` - inspect and attach remote nodes over SSH
- `plantlab capture` - run manual coordinator-driven capture jobs
- `plantlab backup` - create, list, verify, and stage restores
- `plantlab service` - manage PlantLab systemd user services
- `plantlab project` - inspect projects and lifecycle metadata

## Documentation

- [Installation](docs/INSTALLATION.md)
- [Coordinator Deployment](docs/COORDINATOR.md)
- [Camera Node Deployment](docs/CAMERA_NODE.md)
- [Backups](docs/BACKUPS.md)
- [Systemd Services](docs/SYSTEMD.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Development](docs/DEVELOPMENT.md)
- [Architecture](ARCHITECTURE.md)
- [Advanced deployment reference](DEPLOYMENT.md)

## Development

```bash
pnpm install
pnpm dev
pnpm test:unit
```

See [Development](docs/DEVELOPMENT.md) for the full development workflow.
