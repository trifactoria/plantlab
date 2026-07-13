# PlantLab agent protocol

A small, versioned, runtime-neutral contract between a coordinator (the
Next.js app) and any capture agent - today the full TypeScript agent
(`scripts/agent-service.ts`) and the lightweight Python edge agent
(`edge-agent/`, see Part 7 of the Pi Zero edge-agent task). Both
implementations speak the exact same HTTP contract described here; there is
no separate "edge protocol." If you need to change any endpoint's shape,
update this document and both agents in the same change.

Current version: **`1`**. Bump only for a breaking wire-format change.
Every heartbeat reports the protocol version it implements
(`protocolVersion`); the coordinator does not currently reject a mismatched
version, but stores it so `plantlab doctor` can surface it.

## Authentication

Every endpoint below (except `agent-ingest`, which additionally accepts a
legacy shared token - see DEPLOYMENT.md) requires:

```
Authorization: Bearer <node-credential>
```

The credential is a per-node secret (`pln_...`) issued by
`registerOrRotateNode()` on the coordinator and stored raw **only** on the
node itself, at `~/.config/plantlab/agent.env`
(`PLANTLAB_NODE_CREDENTIAL=pln_...`, mode 0600, directory mode 0700). The
coordinator stores only a SHA-256 hash - see `src/lib/operations/nodeCredentials.ts`.
Both agent runtimes read the credential from this same file and path, which
is what makes `probeRemoteCredential()` (`src/lib/operations/credentialRepair.ts`)
work identically for either one.

## Endpoints

All bodies are JSON except `agent-ingest`, which is `multipart/form-data`.

### `POST /api/agents/heartbeat`

Sent on every poll cycle. Also the mechanism that clears a stale
"repair-required" node status - see `recordHeartbeat()`.

Request body:
```json
{
  "hostname": "greenhouse-zero",
  "role": "camera-node",
  "operatingSystem": "Raspberry Pi OS Lite",
  "architecture": "armv6l",
  "softwareVersion": "0.3.1",
  "runtime": "python-edge",
  "protocolVersion": "1",
  "capabilities": ["camera"],
  "environment": {
    "configuredSensorCount": 1,
    "enabledSensorCount": 1,
    "acceptedSensorCount": 1,
    "staleSensorCount": 0,
    "failedSensorCount": 0,
    "lastEnvironmentUploadAt": "2026-07-13T15:30:00Z"
  }
}
```
All fields optional except that omitting everything still records a
heartbeat timestamp. `capabilities` replaces (not merges) whatever the node
previously reported - see `src/lib/operations/capabilities.ts`.
`environment` is aggregate health only; full environmental telemetry uses
the endpoint below.

### `POST /api/agents/credential-check`

Narrow, side-effect-free probe (Part 1 of the credential-recovery task) -
no body required. Never updates `lastHeartbeatAt`/status, so probing a
credential's validity is never mistaken for a real heartbeat. Returns
`{"ok": true, "node": {"name": "...", "role": "..."}}` on success, or a 401
with `{"error": "Unauthorized", "reason": "..."}`.

### `POST /api/agents/cameras`

Reports the node's current camera inventory.
```json
{ "cameras": [ { "stableId": "usb:1-2:046d:0825", "devicePath": "/dev/video0", "name": "Logitech C270", "available": true, "formats": [] } ] }
```
Response includes any active `NodeCameraAssignment`s so the agent knows
what capture settings apply to which physical camera.

### `POST /api/agents/environment`

Reports bounded batches of greenhouse environmental telemetry from an
authenticated node. The Python edge agent can produce this with mock sensor
drivers in development or real DHT22 reads through its explicit `dht22`
driver mode. The wire protocol is unchanged by the selected edge-side
driver.

Request body:
```json
{
  "nodeName": "greenhouse-zero",
  "events": [
    {
      "eventId": "greenhouse-ambient:2026-07-13T15:30:00.000Z:accepted",
      "sensor": {
        "key": "greenhouse-ambient",
        "name": "Greenhouse ambient",
        "type": "dht22",
        "gpio": 4,
        "placement": "Top shelf",
        "enabled": true
      },
      "capturedAt": "2026-07-13T15:30:00.000Z",
      "classification": "accepted",
      "temperatureC": 24.3,
      "humidityPct": 67.2,
      "diagnosticCode": null,
      "diagnosticMessage": null
    }
  ]
}
```

Canonical units are Celsius, percent relative humidity, and UTC ISO-8601
timestamps. Fahrenheit is presentation-only.

Classifications are:

- `accepted` - stored as normal history in `SensorReading`.
- `suspect` - diagnostic only; used for plausible-range or sudden-change
  values awaiting confirmation.
- `rejected` - diagnostic only; hard invalid values or isolated spikes.
- `failed` - diagnostic only; driver read failure.
- `stale` - diagnostic only; no recent accepted reading.
- `driver-unavailable` - diagnostic only; configured sensor has no runtime
  driver available. Real-driver dependency failures use this classification
  with diagnostic codes such as `backend-unavailable`.

The coordinator authenticates with the same bearer credential as other
agent endpoints, verifies that `nodeName` matches the authenticated node,
limits the batch to 100 events, checks string lengths, rejects malformed
timestamps, rejects unknown classifications, enforces finite numeric values,
and independently applies hard physical bounds of `-40..80C` and `0..100%`
humidity. The node owns the richer local validation state machine; the
coordinator enforces safety and storage invariants.

Accepted readings are stored in `SensorReading`. Non-accepted events are
stored in `SensorDiagnostic`, so suspect/rejected values never pollute
normal environmental history. Sensor metadata is upserted into `NodeSensor`
by `(nodeId, key)` on every event; sensors are node-owned and not coupled to
projects in this stage. Retries are idempotent per authenticated node using
`(nodeId, eventId)`.

Response:
```json
{
  "status": "ok",
  "acceptedEventIds": ["greenhouse-ambient:2026-07-13T15:30:00.000Z:accepted"],
  "duplicateEventIds": [],
  "storedReadings": 1,
  "storedDiagnostics": 0
}
```

The batch is processed in a Prisma transaction after request validation. An
invalid batch is rejected before any rows are written.

### `GET /api/nodes/{nodeName}/environment`

Coordinator-side retrieval boundary for future UI work. Returns the latest
environmental sensor status stored for one node:

```json
{
  "node": { "id": "...", "name": "greenhouse-zero", "role": "greenhouse-node" },
  "sensors": [
    {
      "key": "greenhouse-ambient",
      "name": "Greenhouse ambient",
      "type": "dht22",
      "gpio": 4,
      "placement": "Top shelf",
      "enabled": true,
      "latestClassification": "accepted",
      "latestTemperatureC": 24.3,
      "latestHumidityPct": 67.2,
      "lastAttemptAt": "2026-07-13T15:30:00.000Z",
      "lastAcceptedAt": "2026-07-13T15:30:00.000Z",
      "stale": false,
      "consecutiveFailures": 0,
      "consecutiveRejects": 0,
      "lastDiagnosticCode": null,
      "lastDiagnosticMessage": null
    }
  ]
}
```

### `GET /api/agents/jobs/next`

Returns the oldest queued `AgentCaptureJob` for this node, or
`{"job": null}`. Job shape:
```json
{ "job": { "id": "...", "captureSourceId": "...", "assignmentId": "...", "camera": { "devicePath": "/dev/video0", "stableId": "...", "name": null }, "settings": { "width": 1280, "height": 720, "inputFormat": "mjpeg" } } }
```

### `POST /api/agents/jobs/{jobId}/claim`

Body: `{"captureId": "<uuid the agent generates>"}`. Marks the job
`claimed`. A job can only be claimed once; a 409 means someone/something
else already claimed it (or it's no longer queued).

### `POST /api/agents/jobs/{jobId}/complete`

Body: `{"captureId": "..."}` - must match a `SourceCapture` already created
by a prior `agent-ingest` upload with the same `captureId` (ingest always
happens *before* complete). Returns 404 if the ingest hasn't landed yet -
the agent should upload first, then call complete.

### `POST /api/agents/jobs/{jobId}/fail`

Body: `{"error": "human-readable reason"}`. Marks the job `failed`. Always
call this (best-effort, ignore its own failure) when a capture or upload
attempt fails, so the job doesn't stay stuck `claimed` forever.

### `POST /api/agent-ingest`

`multipart/form-data` with two fields:
- `metadata` - JSON string: `{"captureId", "capturedAt" (ISO), "captureSourceId" or "cameraStableId", "originalFilename", "expectedSha256" (64-char hex), "expectedByteSize", "mimeType"}`.
- `image` - the JPEG file itself.

Retried uploads with the same `captureId` and matching checksum/size return
`200 {"status": "already-exists", ...}` (safe to retry indefinitely from an
agent's spool). A different checksum/size for the same `captureId` is a 409
- never silently overwrites. A fresh upload returns
`201 {"status": "created", "sourceCaptureId", "captureId", "storageKey"}`.

## Spool → protocol mapping (what a durable agent implementation looks like)

1. Poll `GET jobs/next`.
2. `POST jobs/{id}/claim` with a locally-generated `captureId`.
3. Capture the frame to the local durable spool (`pending/`) **before**
   attempting any network call - see Part 9/`edge-agent/plantlab_edge_agent/spool.py`
   and `src/lib/operations/agentSpool.ts` for the equivalent TS
   implementation.
4. Move the file to `uploading/`, `POST agent-ingest`.
5. On success, `POST jobs/{id}/complete`, move the file to `acknowledged/`.
6. On failure, `POST jobs/{id}/fail` (best-effort), move the file to
   `failed/`, retry later with backoff.
7. Periodically delete `acknowledged/` files older than the retention
   window.

Both agents implement this same state machine independently (one in
TypeScript against `node:sqlite`, one in Python against the stdlib
`sqlite3`) because the spool is local, private, per-node state - there is
nothing to share at the protocol level beyond the HTTP calls above.
