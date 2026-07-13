# PlantLab Edge Agent

A small capture agent for low-resource devices - originally built for a
Raspberry Pi Zero v1.2 (ARMv6, single-core, 512MB RAM), where the full
Node.js/Next.js-adjacent agent stack is unsupported or not recommended
(see `plantlab node inspect <host>` / `src/lib/operations/remoteNode.ts`
`computeFullAgentSupport()`).

- **Zero third-party dependencies** - stdlib only (`urllib`, `sqlite3`,
  `subprocess`, `json`). No `pip install` of anything beyond this package
  itself is required.
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

This stage does not install `python-kasa`, read DHT22 sensors, connect to
Kasa devices, upload sensor readings, or run automation rules. Planned Kasa
runtime support requires Python 3.11 or newer; `plantlab doctor --node
<ssh-host>` reports the remote Python readiness status when power control
is configured.

## Layout

```
edge-agent/
├── plantlab_edge_agent/   the package: config, protocol, spool, camera, agent loop, CLI
├── install.sh             installer - see the file for exact steps
├── requirements.txt       intentionally empty (see pyproject.toml)
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
  `greenhouse-node`, but live DHT22 reads, Kasa communication, readings
  upload, and automation rules are not implemented yet.
