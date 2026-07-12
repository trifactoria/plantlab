# PlantLab production services (systemd)

Two independent, long-running user-level systemd services:

- **`plantlab-web.service`** - the Next.js production web app (`npm run start`).
- **`plantlab-camera.service`** - the camera/scheduler service (`npm run camera:service`),
  which manages scheduled capture for every capture-enabled project *and*
  every shared shelf `CaptureSource`, in one process.

Install both once per machine; you do not create one service per project.

User-level units are used (not system-level units with `User=`) because they
run as your own login user and can access `/dev/video*` the same way your
shell can, without needing root or a hardcoded username in the unit file -
see "run as the normal PlantLab user rather than root" in the top-level
`DEPLOYMENT.md`.

## Prerequisites

Run `plantlab doctor` first (see `DEPLOYMENT.md`) - it checks everything
below in one pass. Summarized:

- `npm` (or `pnpm`) on `PATH` for the user that will run the services.
- `ffmpeg` and `v4l2-ctl` installed (`sudo apt install ffmpeg v4l-utils`).
- If `/dev/video*` is only readable/writable by the `video` group, add
  yourself to it once and log out/in (or reboot):

  ```
  sudo usermod -aG video "$USER"
  ```

- If this machine won't always have an interactive login session, allow user
  services to run without one:

  ```
  loginctl enable-linger "$USER"
  ```

- The app must already be built (`npm run build`) before starting
  `plantlab-web.service` - the unit does not build on every start.

## Install

From the repository root, either run `plantlab install` (preferred - also
validates dependencies, prepares data directories, and records this
machine's role; see `DEPLOYMENT.md` "PlantLab CLI"/"Node roles") or run
this script directly for just the unit-generation step:

```
./deploy/systemd/install.sh
```

This substitutes the repository path and your `npm`/`pnpm` executable path
into both `.service.template` files and writes the results to
`~/.config/systemd/user/plantlab-web.service` and
`~/.config/systemd/user/plantlab-camera.service`. It never hardcodes a
username - each unit runs as whichever user owns the systemd `--user`
session that loads it.

`plantlab-web.service.template` sets `PLANTLAB_LOCAL_CAMERA_ENABLED=1`
directly, since this deployment target is a single local machine with an
attached camera, not a publicly hosted server (see
`src/lib/localOnly.ts`). Delete that line from the installed unit if you
ever repurpose it as a hosted-elsewhere deployment with no local hardware.

Optional environment variables (e.g. `CAMERA_DEVICE`, `CAMERA_WARMUP_SECONDS`,
`CAPTURE_SERVICE_REFRESH_INTERVAL_MS`, `PLANTLAB_BACKUP_DIR`) can be placed in
an optional file at `~/.config/plantlab/web.env` and/or
`~/.config/plantlab/camera.env`, or in `.env.local` in the repository root
(loaded by both services). All are loaded if present and silently skipped if
absent. Never put secrets in a file that isn't already `.gitignore`d.

## Enable and start

```
systemctl --user daemon-reload
systemctl --user enable --now plantlab-web.service plantlab-camera.service
```

## Check status

```
systemctl --user status plantlab-web.service
systemctl --user status plantlab-camera.service
```

Also check `/api/service-status` (requires `PLANTLAB_LOCAL_CAMERA_ENABLED=1`
in production - see above) or the "Capture Service" panel on the PlantLab
home page for last heartbeat, active project/source count, and per-project
next capture time.

## View logs

```
journalctl --user -u plantlab-web.service -f
journalctl --user -u plantlab-camera.service -f
```

Drop `-f` to see history instead of following. Add `--since "1 hour ago"` to
scope the range.

## Restart

```
systemctl --user restart plantlab-web.service
systemctl --user restart plantlab-camera.service
```

Restarting `plantlab-web.service` picks up a new build (`npm run build`
first). Restarting `plantlab-camera.service` picks up code changes; it does
**not** need to happen when you enable/disable/edit a project or capture
source - the running service re-reads configuration on every scheduling
pass. Restarting either service does not corrupt the database or in-flight
photo files - see "Graceful service behavior" in `DEPLOYMENT.md`.

## Stop

```
systemctl --user stop plantlab-web.service plantlab-camera.service
```

## Uninstall

```
systemctl --user disable --now plantlab-web.service plantlab-camera.service
rm ~/.config/systemd/user/plantlab-web.service ~/.config/systemd/user/plantlab-camera.service
systemctl --user daemon-reload
```

## Development / debugging

`npm run camera:watch -- <project-id>` still exists for watching and
debugging a single project's schedule in a terminal. It is a
development/debugging command only - the systemd service always runs
`camera:service`, which manages every capture-enabled project and shared
capture source from one process.

`npm run dev` (development mode) must never be run at the same time as
`plantlab-web.service` against the same repository checkout - both write to
the same `.next` build directory, and running them concurrently corrupts
the production build (see "Diagnosis" in `DEPLOYMENT.md`).
