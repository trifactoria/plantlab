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

## A required service is "masked"

`plantlab node attach`/`plantlab doctor --fix` detect and clear this
automatically - a required unit masked by a previous installation attempt
(or by hand, e.g. `systemctl --user mask <unit>` during earlier manual
debugging) is unmasked before it's reinstalled and started. You should
never need to run `systemctl --user unmask` yourself; if you ever do,
that's a sign `plantlab doctor --node <host> --fix` should be filed as a
bug instead.

Symptom: `Failed to enable unit: Unit ... is masked`. Fix:

```bash
plantlab doctor --node <host> --fix
```

## "Node role is not configured" but I already ran attach

This means a previous attach attempt failed partway through. It is safe to
retry - convergence is idempotent and resumes rather than repeating broken
steps:

```bash
plantlab node attach <host>
# or, for a guided repair with more granular prompts:
plantlab doctor --node <host> --fix
```

The coordinator retains any credential already issued for the node and
reuses it rather than rotating unnecessarily.

## "Column does not exist" / stale database schema

A service was started against a database that hasn't received recent
migrations. Fix:

```bash
plantlab update
```

This backs up the database first, then applies pending migrations (or, for
a database that predates this project's migration history, safely
baselines it first - see `DEPLOYMENT.md` "Database migration policy").
`plantlab service start`/`restart` also refuse outright (rather than
crashing later) if the schema is not current when starting
`plantlab-web.service` or `plantlab-camera.service`.

## "PLANTLAB_NODE_CREDENTIAL is not set" after a successful-looking attach

`node attach` reported "Existing credential retained" but the agent still
won't authenticate. This should now self-heal automatically:

```bash
plantlab doctor --node <host> --fix
```

or simply re-run attach - both now probe the credential with a real
authenticated request against the coordinator (not just file
existence/permissions) and rotate automatically when it's demonstrably
invalid. You should see:

```
Existing node credential is missing.
Rotating credential automatically...

✓ Previous credential revoked
✓ New credential installed securely
✓ Agent restarted
✓ Authenticated heartbeat received
```

The raw credential is never printed or logged at any point - only a
pass/fail status. See `DEPLOYMENT.md` "Automatic credential recovery" for
the full root-cause writeup.

## A Raspberry Pi Zero (or similar low-resource device) is slow or fails to build

Run `plantlab node inspect <host>` first - if it reports "Full PlantLab
Node agent: Unsupported or not recommended", the device should run the
lightweight Python edge agent instead, not the full Node.js stack. Either
`./install.sh` (run locally on the device) or `plantlab node attach <host>`
(run from the coordinator) will detect this automatically and offer the
edge agent path. See `edge-agent/README.md` and `DEPLOYMENT.md`
"Lightweight edge agent" for details.

## Logs

See [Systemd Services](SYSTEMD.md) for `journalctl` commands.
