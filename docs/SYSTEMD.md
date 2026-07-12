# Systemd Services

PlantLab installs user-level systemd services.

## Services

- `plantlab-web.service` - production web app
- `plantlab-camera.service` - local scheduler/capture service
- `plantlab-agent.service` - remote camera-node agent

## Commands

```bash
plantlab service status
plantlab service start
plantlab service stop
plantlab service restart
```

By default, service commands manage the services expected for the configured
role:

- coordinator: `plantlab-web.service`
- camera-node: `plantlab-agent.service`
- standalone: `plantlab-web.service` and `plantlab-camera.service`

Use `--service web`, `--service camera`, or `--service agent` for one
low-level service. Use `--all` only when you intentionally want every
PlantLab service.

Remote service checks:

```bash
plantlab service status --node xps
plantlab service restart --node xps --service agent
```

## Logs

```bash
journalctl --user -u plantlab-web.service -f
journalctl --user -u plantlab-camera.service -f
journalctl --user -u plantlab-agent.service -f
```

The generated unit templates live in `deploy/systemd/`. `plantlab install`
and `plantlab update` are the canonical way to install/refresh these units
now - they detect and clear a stale mask, write units atomically, and
enable/start only the units the configured role expects. Running
`deploy/systemd/install.sh` directly still works as a manual, lower-level
fallback that only (re)writes unit files, without touching role
configuration or service state - see [Troubleshooting](TROUBLESHOOTING.md)
for masked-unit recovery.
