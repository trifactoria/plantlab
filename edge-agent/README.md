# PlantLab Edge Agent

A small capture agent for low-resource devices - originally built for a
Raspberry Pi Zero v1.2 (ARMv6, single-core, 512MB RAM), where the full
Node.js/Next.js-adjacent agent stack is unsupported or not recommended
(see `plantlab node inspect <host>` / `src/lib/operations/remoteNode.ts`
`computeFullAgentSupport()`).

- **Small dependency surface** - camera and protocol paths use the Python
  stdlib. Real DHT22 reads require the edge-node-only `pigpio` Python
  client and `pigpiod` daemon; camera-only and mock-sensor nodes do not.
- Speaks the exact same coordinator protocol as the full TypeScript agent
  (`scripts/agent-service.ts`) - see `docs/AGENT_PROTOCOL.md`. There is
  only one protocol, not two.
- USB/V4L2 webcams only for now, via `ffmpeg` + `v4l2-ctl` (both external
  binaries). No video streaming, one manual/scheduled frame at a time.
- A durable local spool (`~/.local/state/plantlab-edge-agent/`) survives
  restarts and power loss - captures are written and recorded before any
  network call is attempted.

## Install

```sh
./install.sh
```

or remotely, from the coordinator:

```sh
plantlab node attach <ssh-host>
```

`plantlab node inspect <ssh-host>` will recommend this path automatically
for a Pi-Zero-class device. Neither install path ever asks you to create,
retrieve, or paste a credential by hand - the coordinator issues one
automatically during `node attach` / `doctor --fix`.

The installer creates a lightweight local command, without installing the
full Node CLI:

```sh
plantlab-edge status
plantlab-edge doctor
plantlab-edge config show
plantlab-edge camera list
plantlab-edge camera refresh
plantlab-edge sensor probe
plantlab-edge sensor test <sensor-key>
plantlab-edge sensor mode mock|dht22|disabled
plantlab-edge service status
plantlab-edge service restart
plantlab-edge logs
plantlab-edge version
```

These commands use only Python and the copied `edge-agent/` package. They
never print the node credential.

## Greenhouse configuration foundations

For `greenhouse-node` roles, `plantlab node attach <ssh-host>` can now
persist optional greenhouse hardware configuration in:

```text
~/.config/plantlab/edge-agent.json
```

The supported stage-one sections are configuration only:

```json
{
  "role": "greenhouse-node",
  "nodeName": "greenhouse-zero",
  "coordinatorUrl": "http://coordinator:3000",
  "capabilities": ["camera", "temperature", "humidity", "relay", "fan", "light", "pump"],
  "sensors": [
    {
      "key": "greenhouse-ambient",
      "name": "Greenhouse ambient",
      "type": "dht22",
      "gpio": 4,
      "placement": "Greenhouse ambient",
      "enabled": true
    }
  ],
  "power": {
    "provider": "kasa",
    "host": "192.168.1.72",
    "outlets": {
      "fans": "greenhouse-fans",
      "water": "greenhouse-water",
      "lights": "greenhouse-lights"
    }
  }
}
```

GPIO values use BCM numbering, not physical header pin numbers. Sensor
keys must be unique, GPIO assignments must be unique, and the only sensor
driver type accepted in this stage is `dht22`.

Kasa credentials are not stored in `edge-agent.json`. If configured, they
belong in:

```text
~/.config/plantlab/greenhouse.env
```

with owner-only permissions. The current keys are:

```dotenv
KASA_USERNAME=
KASA_PASSWORD=
```

This stage does not install `python-kasa`, connect to Kasa devices, control
outlets, or run automation rules. Planned Kasa runtime support requires
Python 3.11 or newer; `plantlab doctor --node <ssh-host>` reports the
remote Python readiness status when power control is configured.

## Environmental telemetry

Configured greenhouse sensors are loaded into a hardware-independent runtime.
The driver mode is explicit:

```sh
plantlab-edge sensor mode mock      # deterministic development readings
plantlab-edge sensor mode dht22     # real DHT22 through pigpio
plantlab-edge sensor mode disabled  # do not sample configured sensors
```

The service mode is stored as a systemd user drop-in under:

```text
~/.config/systemd/user/plantlab-edge-agent.service.d/
```

With no `PLANTLAB_GREENHOUSE_SENSOR_DRIVER` value, enabled sensors report
`driver-unavailable` diagnostics instead of silently producing mock data.
Real-driver failures never fall back to mock readings.

For development and tests, opt into deterministic mock readings:

```sh
plantlab-edge sensor mode mock
plantlab-edge service restart
```

For real DHT22 hardware, `plantlab node attach <ssh-host>` detects enabled
`dht22` sensors, verifies the `pigpio` backend, offers to install/update
the backend, and offers to switch an existing mock drop-in to:

```text
PLANTLAB_GREENHOUSE_SENSOR_DRIVER=dht22
```

The backend can also be inspected locally without taking a reading:

```sh
plantlab-edge sensor probe
```

A one-shot hardware test reads a configured sensor several times and runs
the normal validation pipeline:

```sh
plantlab-edge sensor test greenhouse-ambient --attempts 5 --interval 3
```

The selected DHT22 backend is `pigpio`: the Python package talks to the
`pigpiod` daemon, which owns the timing-sensitive GPIO edge capture. This
keeps the PlantLab loop out of CPU-heavy busy polling on Pi Zero hardware.
The attach flow installs distro `pigpio`/`python3-pigpio` packages when
available and uses a pinned `pigpio==1.78` Python client only if needed.

Mock samples use Celsius and percent relative humidity. The validation
pipeline rejects missing/non-finite values, rejects values outside hard
physical bounds (`-40..80C`, `0..100%` humidity), marks values outside
plausible greenhouse bounds (`0..50C`, `5..100%`) as `suspect`, and marks
large sudden deltas as `suspect` until a following sample confirms the new
baseline. Isolated spikes become `rejected`. Sensors with no recent accepted
reading become `stale`.

Environmental events are stored in the same local SQLite spool used by
camera captures. Uploads are batched to `POST /api/agents/environment`,
acknowledged events are retained briefly and then cleaned up, and failed
uploads retry with backoff. Repeated identical diagnostics are rate-limited
so a broken sensor does not fill the spool every polling cycle.

## DHT22 wiring

PlantLab uses BCM GPIO numbering. For the current greenhouse-zero
configuration:

```text
DATA -> BCM GPIO 8 / physical header pin 24
```

For a bare four-pin DHT22:

```text
Pin 1 VCC  -> Pi 3.3V
Pin 2 DATA -> configured BCM GPIO
Pin 3 NC   -> not connected
Pin 4 GND  -> Pi ground
```

Many breakout boards include a data-line pull-up resistor. Bare sensors
usually need an external pull-up between DATA and 3.3V. Verify the labels
or datasheet for the exact module before wiring; not every board exposes
pins in the same order.

BCM GPIO 8 is also SPI CE0 on Raspberry Pi. `plantlab-edge sensor probe`
warns when SPI appears enabled, but PlantLab does not disable SPI
automatically.

## Idle camera lifecycle

Normal heartbeats are lightweight. They do not enumerate `/dev/video*`, run
`v4l2-ctl`, call `udevadm`, inspect formats, or launch `ffmpeg`.

Verified camera inventory is explicit and serialized. It runs only when:

- the coordinator has a pending camera refresh request, such as from
  `plantlab camera refresh --node <node>`
- `plantlab node attach <ssh-host>` starts the edge agent, receives a
  heartbeat, and then requests camera inventory
- `plantlab-edge camera refresh` is run locally on the node

The agent polls `/api/agents/cameras/refresh` separately from capture jobs.
The default `cameraRefreshPollIntervalSeconds` is 60 seconds. Capture-job
polling still uses `pollIntervalSeconds`, and a no-job response never opens
the camera.

The last successful verified inventory is cached locally at:

```text
~/.local/state/plantlab-edge-agent/camera-inventory-cache.json
```

The cache contains ordinary metadata only: stable IDs, device paths, USB
identity, formats, verified probe mode, and timestamps. It does not contain
images. Startup and diagnostics can read the cache without touching camera
hardware. A refresh lock file prevents overlapping verified inventory
passes:

```text
~/.local/state/plantlab-edge-agent/camera-inventory-refresh.lock
```

Useful diagnostics:

```sh
plantlab-edge config show
plantlab-edge camera refresh
```

`config show` reports cache presence, age, last verified time, whether a
refresh is already running, the refresh-poll interval, and whether a camera
subprocess appears active.

To confirm Pi Zero idle behavior:

```sh
ps -eo pid,etimes,pcpu,pmem,rss,cmd --sort=-pcpu | head -20
```

When idle there should be no recurring `ffmpeg`, `v4l2-ctl`, or `udevadm`
work from the edge agent. During an explicit camera refresh, `ffmpeg`
appears temporarily and exits after the one inventory pass.

## Layout

```
edge-agent/
├── plantlab_edge_agent/   the package: config, protocol, spool, camera, agent loop, CLI
├── install.sh             installer - see the file for exact steps
├── requirements.txt       intentionally empty; DHT22 deps are installed on edge nodes only
├── pyproject.toml         packaging metadata (no required deps)
├── systemd/               the systemd --user unit template
└── tests/                 pytest suite (mocked hardware/network - see Part 15)
```

## Updating

This directory is deliberately self-contained and small enough to copy
wholesale over SSH (`plantlab node attach` does exactly that) or package as
a tiny tarball - the Pi never needs to clone or retain the full PlantLab
repository. To update an already-installed edge agent, copy a newer
`edge-agent/` directory over and re-run `./install.sh` (idempotent - it
never touches an existing credential). Coordinator attachment always
converges `~/.config/plantlab/edge-agent.json` to the coordinator-known
role, node name, URL, spool root, and camera capability while preserving
user-tuned intervals and byte limits. There is no `plantlab update`
equivalent for the edge agent yet; see "Known limitations" below.

## Known limitations

- Upload is a single in-memory multipart body (size-capped at 8MB by
  default, `maxUploadBytes` in `edge-agent.json`) rather than a true
  streaming multipart encoder - simpler, and adequate for the bounded JPEG
  frame sizes this agent captures (a few hundred KB at 720p), but not
  appropriate if capture resolution is raised significantly.
- No independent update mechanism yet (see above) - re-copying the
  directory and re-running `install.sh` is the only path today.
- Sensor/relay capabilities can be configured and reported for
  `greenhouse-node`; environmental readings can be uploaded from mock or
  real DHT22 drivers. Kasa communication, outlet control, and automation
  rules are not implemented yet.
