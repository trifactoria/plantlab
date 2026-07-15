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
- `samplingEnabled`
- `samplingIntervalMinutes`
- `samplingAnchorAt`
- `lastSampledSlotAt`

Switching a project source deactivates the previous active viewport and
creates a new full-frame viewport. Existing photos and source captures are
not deleted. Existing direct-local projects remain classified as
`direct-local` when they have `Project.cameraDevice` and no active
`ProjectViewport`.

For CaptureSource projects, `ProjectViewport` owns the project sampling
policy. `Project.photoIntervalMinutes` remains a compatibility fallback and
is still authoritative for direct-local projects, but it is not the shared
source's physical capture cadence.

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
Every active project viewport that is due under its project sampling policy
consumes the uploaded source capture through viewport fan-out.

Remote assigned sources queue one `AgentCaptureJob` per source and
scheduled slot. The node captures and uploads through `agent-ingest`; ingest
runs viewport fan-out. Local configured sources still capture directly in
the coordinator process.

Project-specific schedules remain supported for legacy direct-local
projects. The initial shared-source policy uses the `CaptureSource`
schedule fields for deduplicated shared capture.

CaptureSource schedule ownership:

- base physical cadence is `CaptureSource.photoIntervalMinutes`;
- default for newly configured greenhouse node sources is 15 minutes;
- default greenhouse timezone is `America/New_York`;
- default greenhouse active window is `08:00` inclusive through `00:00`
  exclusive on the following local day;
- existing explicit source schedules are preserved by migrations.

Project sampling:

- a project with 15-minute sampling may consume every eligible 15-minute source capture;
- a project with 30-minute sampling consumes the nearest eligible source capture for each 30-minute project slot;
- a project with 60-minute sampling consumes the nearest eligible source capture for each 60-minute project slot;
- one `SourceCapture` may fan out to several projects;
- project sampling never queues a second physical capture when a suitable shared source capture exists.

The current matching algorithm uses the nearest project sample slot derived
from `samplingAnchorAt` and `samplingIntervalMinutes`. The tolerance is half
the source cadence. It is idempotent through the unique
`projectId + viewportId + sampleSlotAt` sample key.

## Illumination Policy

A `CaptureSource` may optionally reference a `NodeOutlet` as illumination:

- `illuminationPolicy="unrestricted"` captures according to source cadence
  and active window regardless of outlet state.
- `illuminationPolicy="only-while-on"` captures scheduled slots only when
  the assigned outlet's observed `actualState` is `true`.

The scheduler uses observed outlet state, not requested commands. If the
light is off, it records a skipped occurrence with reason
`illumination-off`. If state is unknown or unavailable, it records
`illumination-state-unknown`. These skips are not camera hardware failures.

Manual project capture bypasses source cadence, the active daily window, and
only-while-on scheduled eligibility. It does not toggle the outlet. When the
observed illumination outlet is off, the manual result includes
`illuminationWarning: true` and `illuminationState: false`.

## Source Occurrences

Scheduled source slots are represented by `CaptureSourceOccurrence` when a
logical due slot is queued, captured, skipped, or failed. The stable status
vocabulary is:

- `captured`
- `queued`
- `failed`
- `expired`
- `skipped-illumination-off`
- `skipped-illumination-unknown`
- `skipped-source-disabled`
- `skipped-outside-window`

The scheduler records logical due slots, not every polling interval.

## Project Camera Summary

`GET /api/projects/:projectId/camera-summary` returns the composed contract
for Claude's future Camera tab:

- `mode`: `none`, `direct-local`, or `capture-source`;
- `camera`: selected camera display name, reported name, node, availability,
  and backend-provided links;
- `source.cadence`: source interval, timezone, daily window, and next source
  capture;
- `source.illumination`: policy, outlet identity, and observed state;
- `source.mode`: currently configured physical mode;
- `projectSampling`: enabled flag, interval, next sample, last sample, and
  recent missing count;
- `latestCapture`: latest shared source capture and project photo link when
  available;
- `recentOccurrence`: latest source slot decision;
- `legacy`: compatibility schedule conflicts that should not be shown as
  the physical source cadence.

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
