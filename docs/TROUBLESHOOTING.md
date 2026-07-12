# Troubleshooting

Start with:

```bash
plantlab doctor
```

Warnings include suggested next actions. Common warnings are:

- no backups yet
- no camera test capture was requested
- services are not running
- coordinator node tables need migration

## Installer Output

Run with verbose logging:

```bash
./install.sh --verbose
```

## Camera Access

List detected cameras:

```bash
plantlab camera list
```

If camera devices exist but capture fails, check formats:

```bash
v4l2-ctl -d /dev/video4 --list-formats-ext
```

## Remote Nodes

```bash
plantlab node inspect xps
plantlab doctor --node xps
plantlab doctor --node xps --fix
plantlab service status --node xps
```

SSH aliases must resolve through `~/.ssh/config`.

`plantlab node attach <host>` is the guided conversion and enrollment flow.
It is the right command when an existing PlantLab machine should become a
camera node. `plantlab doctor --node <host> --fix` is the right command for
credential, service, heartbeat, and camera-inventory repair after attachment.
Do not rerun `./install.sh` for normal remote agent failures.

## Logs

See [Systemd Services](SYSTEMD.md) for `journalctl` commands.
