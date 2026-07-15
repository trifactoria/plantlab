# Distributed Project Monitoring Contracts

This document captures the first backend contract for project capture and
environmental monitoring across coordinator-managed nodes.

## Project Capture Sources

Projects should use `CaptureSource` as their durable camera selection. Do
not store `/dev/videoN` or other transient remote device paths on `Project`
for node-backed cameras.

`GET /api/capture-sources/available` returns configured sources:

- `id`, `name`
- `mode`: `local` or `remote-node`
- `node`: node identity for remote sources, otherwise `null`
- `logicalCameraName`
- `available`, `retired`, `assignmentActive`, `currentEndpointAvailable`
- `width`, `height`, `rotation`, `inputFormat`
- `lastInventoryAt`, `lastSuccessfulCapture`, `recentError`
- `supportsScheduledCapture`, `selectable`

Normal project creation/update should offer `selectable` sources. Editing
an existing project may call the endpoint with `includeUnavailable=true` to
display degraded selections.

## Project Capture Binding

The initial canonical project binding is an active full-frame
`ProjectViewport`:

- `projectId`
- `captureSourceId`
- `cropX=0`, `cropY=0`, `cropWidth=1`, `cropHeight=1`
- `active=true`

Switching a project source deactivates the previous active viewport and
creates a new full-frame viewport. Existing photos and source captures are
not deleted. Existing direct-local projects remain classified as
`direct-local` when they have `Project.cameraDevice` and no active
`ProjectViewport`.

Project capture modes:

- `none`
- `direct-local`
- `capture-source`

## Project Creation And Updates

`POST /api/projects` accepts:

```json
{
  "captureSourceId": "capture-source-id",
  "captureEnabled": true
}
```

When `captureSourceId` is present, the server validates that the source is
active, not retired, has an active assignment where relevant, and supports
scheduled capture. Remote device paths from clients are ignored for this
mode.

`PATCH /api/projects/:projectId` accepts `captureSourceId` to switch
sources. Passing `null` disables the capture-source binding and allows the
legacy direct-local fields to remain compatible.

## Scheduling Policy

`CaptureSourceScheduler` is source-authoritative for shared source slots.
One `CaptureSource` slot produces one full-resolution `SourceCapture`.
Every active project viewport for that source consumes the uploaded source
capture through viewport fan-out.

Remote assigned sources queue one `AgentCaptureJob` per source and
scheduled slot. The node captures and uploads through `agent-ingest`; ingest
runs viewport fan-out. Local configured sources still capture directly in
the coordinator process.

Project-specific schedules remain supported for legacy direct-local
projects. The initial shared-source policy uses the `CaptureSource`
schedule fields for deduplicated shared capture.

## Project Sensor Bindings

`ProjectSensorBinding` links projects to coordinator-owned sensor rows:

- `projectId`
- `nodeId`
- `sensorId`
- `label`
- `role`
- `enabled`
- `linkedAt`, `unlinkedAt`

Use immutable `sensorId` for bindings. Sensor rename does not affect the
binding. Unlinking disables the binding and sets `unlinkedAt`; it never
deletes readings.

Routes:

- `GET /api/projects/:projectId/sensors`
- `POST /api/projects/:projectId/sensors`
- `PATCH /api/projects/:projectId/sensors/:bindingId`
- `DELETE /api/projects/:projectId/sensors/:bindingId`

Only applied/configured-active sensors are normally linkable. Historical or
retired sensors can remain queryable through existing rows and explicit
bindings.

## Project Metric History

`GET /api/projects/:projectId/metrics/history` uses the same range,
resolution, aggregation, UTC bucket semantics, accepted-reading filtering,
and Celsius units as node metric history.

Required query parameters:

- `metrics=temperatureC,humidityPct`

Optional query parameters:

- `bindingIds=<id>,<id>`
- `from=<ISO timestamp>`
- `to=<ISO timestamp>`
- `resolution=raw|5m|15m|1h`
- `timeZone=<IANA timezone>`

Series include `bindingId`, `node`, `sensorId`, `role`, and `degraded` in
addition to the generic chart fields.

## Photo Environment

`GET /api/projects/:projectId/photos/:photoId/environment` returns each
enabled binding's nearest accepted reading within `maxDistanceMs`
(default ten minutes, maximum one hour). No reading is returned when the
nearest accepted measurement is outside the window.
