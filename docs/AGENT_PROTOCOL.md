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
  "capabilities": ["camera"]
}
```
All fields optional except that omitting everything still records a
heartbeat timestamp. `capabilities` replaces (not merges) whatever the node
previously reported - see `src/lib/operations/capabilities.ts`.

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
