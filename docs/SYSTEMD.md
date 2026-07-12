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

Remote service checks:

```bash
plantlab service status --node xps
```

## Logs

```bash
journalctl --user -u plantlab-web.service -f
journalctl --user -u plantlab-camera.service -f
journalctl --user -u plantlab-agent.service -f
```

The generated unit templates live in `deploy/systemd/`.
