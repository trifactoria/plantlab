# Camera Node Deployment

A camera node has one or more attached cameras and reports to a coordinator.
It does not run the canonical PlantLab project database.

## Install

Most camera nodes are configured from the coordinator:

```bash
plantlab node attach xps --coordinator-url http://plantlab:3000
```

This writes:

- `plantlab.config.json` in the remote checkout
- `~/.config/plantlab/agent.env` with the node credential
- `plantlab-agent.service` as a systemd user service

## Local Spool

The agent stores durable local state under:

```text
~/.local/state/plantlab-agent
```

The spool contains pending, uploading, acknowledged, and failed captures.
Files stay local until the coordinator acknowledges the upload.

## Diagnostics

```bash
plantlab doctor
plantlab service status
plantlab camera list
```

From the coordinator:

```bash
plantlab doctor --node xps
plantlab service status --node xps
plantlab camera list --node xps
```
