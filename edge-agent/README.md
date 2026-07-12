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
never touches an existing credential or config). There is no `plantlab
update` equivalent for the edge agent yet; see "Known limitations" below.

## Known limitations

- Upload is a single in-memory multipart body (size-capped at 8MB by
  default, `maxUploadBytes` in `edge-agent.json`) rather than a true
  streaming multipart encoder - simpler, and adequate for the bounded JPEG
  frame sizes this agent captures (a few hundred KB at 720p), but not
  appropriate if capture resolution is raised significantly.
- No independent update mechanism yet (see above) - re-copying the
  directory and re-running `install.sh` is the only path today.
- Sensor/relay capabilities are modeled (`capabilities.py`/the
  coordinator's capability list) but not implemented - camera-only, by
  design (see the task's explicit "do not implement sensor or relay
  control yet").
