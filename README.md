# PlantLab

PlantLab is a local-first experiment tracking platform for plant breeding, mycology, tissue culture, microscopy, and other biological projects that change over time.

The goal is to make documenting long-running experiments effortless by combining scheduled image capture, event timelines, and structured project data into a single application.

## Current Features

- 🌱 Multi-project experiment management
- 📸 Local webcam image capture
- 🗂 Local filesystem photo storage
- 🪴 Plant tracking
- 📝 Timestamped event logging
- 📅 Chronological experiment timelines
- ⚙️ Camera configuration and preview
- 💾 SQLite + Prisma backend
- 🚫 Local-first (no cloud required)

## Planned Features

- Automatic scheduled image capture
- Camera profiles
- Event image cropping
- Growth charts
- Computer vision measurements
- Selective breeding genealogy
- Time-lapse generation
- OpenFlexure microscope integration
- Multi-camera support
- Raspberry Pi capture nodes

PlantLab is designed as a practical digital lab notebook that scales from simple webcam time-lapses to complex selective breeding and microscopy workflows while keeping all experiment data under the user's control.

## Operating PlantLab

`plantlab` is the operational CLI (`plantlab doctor`, `plantlab backup`,
`plantlab service`, `plantlab project`, ...) - see
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full command reference and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the codebase is organized
and where it's headed as a multi-node platform.

## Production deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for building and running PlantLab as
two long-running production processes (the web app and the camera/scheduler
service) on an Ubuntu machine with an attached camera, including systemd
units and a `plantlab doctor` readiness check.
