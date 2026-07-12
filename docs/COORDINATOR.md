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
plantlab camera list --node xps
plantlab camera attach --node xps
plantlab capture test --node xps
```

`node attach` writes remote node configuration over SSH, creates a per-node
credential, installs `plantlab-agent.service`, and waits for the node to
report camera inventory.

## Notes

- The coordinator database remains local SQLite.
- Capture files move through `/api/agent-ingest`, not shared folders.
- Existing projects and capture sources are not assigned automatically.
