# Coordinator Deployment

A coordinator owns the canonical PlantLab SQLite database and image storage.
Camera nodes upload captures to it over ordinary HTTP.

## Install

```bash
./install.sh --role coordinator
```

Then confirm:

```bash
plantlab doctor
plantlab service status
```

## Attach a Camera Node

```bash
plantlab node inspect xps
plantlab node attach xps --coordinator-url http://plantlab:3000
```

`node attach` writes remote node configuration over SSH, creates a per-node
credential, installs `plantlab-agent.service`, and waits for the node to
send a real heartbeat and report camera inventory. If the remote machine is
currently configured as `standalone`, the command explains the conversion,
preserves existing data, stops the web/camera services, and starts only the
agent service.

After the agent is healthy, `node attach` offers to configure a camera and
run a test capture. You can also run those steps separately:

```bash
plantlab camera list --node xps
plantlab camera attach --node xps
plantlab capture test --node xps
```

Use `plantlab doctor --node xps --fix` for guided repair of credential,
service, or agent startup problems. Do not rerun `./install.sh` for ordinary
remote agent failures.

## Notes

- The coordinator database remains local SQLite.
- Capture files move through `/api/agent-ingest`, not shared folders.
- Existing projects and capture sources are not assigned automatically.
