# PlantLab capture service (systemd)

Runs `pnpm camera:service` — the single long-running process that manages
capture for every capture-enabled project — as a user-level systemd service.
Install it once per machine; you do not create one service per project.

A user-level unit is used (not a system-level unit with `User=`) because it
runs as your own login user and can access `/dev/video*` the same way your
shell can, without needing root or a hardcoded username in the unit file.

## Prerequisites

- `pnpm` on `PATH` for the user that will run the service.
- If the camera device is only readable/writable by the `video` group, add
  yourself to it once and log out/in (or reboot):

  ```
  sudo usermod -aG video "$USER"
  ```

- If this machine won't always have an interactive login session, allow user
  services to run without one:

  ```
  loginctl enable-linger "$USER"
  ```

## Install

From the repository root:

```
./deploy/systemd/install.sh
```

This substitutes the repository path and your `pnpm` executable path into
`deploy/systemd/plantlab-capture.service.template` and writes the result to
`~/.config/systemd/user/plantlab-capture.service`. It never hardcodes a
username — the unit runs as whichever user owns the systemd `--user` session
that loads it.

Optional environment variables (e.g. `CAMERA_DEVICE`, `CAMERA_WARMUP_SECONDS`,
`CAPTURE_SERVICE_REFRESH_INTERVAL_MS`) can be placed in an optional file at
`~/.config/plantlab/capture.env`, or in `.env.local` in the repository root.
Both are loaded if present and silently skipped if absent.

## Enable and start

```
systemctl --user daemon-reload
systemctl --user enable --now plantlab-capture.service
```

## Check status

```
systemctl --user status plantlab-capture.service
```

Also check `/api/service-status` (when running the app locally) or the
"Capture Service" panel on the PlantLab home page for last heartbeat,
active project count, and per-project next capture time.

## View logs

```
journalctl --user -u plantlab-capture.service -f
```

Drop `-f` to see history instead of following. Add `--since "1 hour ago"` to
scope the range.

## Restart

```
systemctl --user restart plantlab-capture.service
```

Restarting picks up code changes; it does **not** need to happen when you
enable/disable/edit a project — the running service re-reads project
configuration on every scheduling pass.

## Stop

```
systemctl --user stop plantlab-capture.service
```

## Uninstall

```
systemctl --user disable --now plantlab-capture.service
rm ~/.config/systemd/user/plantlab-capture.service
systemctl --user daemon-reload
```

## Development / debugging

`pnpm camera:watch -- <project-id>` still exists for watching and debugging a
single project's schedule in a terminal. It is a development/debugging
command only — the systemd service always runs `pnpm camera:service`, which
manages every capture-enabled project from one process.
