# Dashboard Data Contracts

Last updated: 2026-07-15

These backend contracts prepare the PlantLab dashboard and project layout refactor. They do not redesign the visible UI.

## Environment Tab

Use metric history for temperature and humidity, then overlay observed power state from:

```http
GET /api/nodes/:nodeName/power/history?from=<iso>&to=<iso>&outletKeys=fans,lights,water
```

The response is UTC and gap-aware:

- `initialState` is `true`, `false`, or `null` when state before the range is unknown.
- `segments` cover known ON/OFF spans through the requested range.
- `events` list observed transitions inside the range.
- The frontend must not infer history from current outlet state.

## Projects Tab

Use project summaries plus:

```http
GET /api/projects/:projectId/capture-summary
```

The `effectiveSchedule` object is canonical:

- `mode: "none"` means no selected capture path.
- `mode: "direct-local"` means project schedule fields are authoritative.
- `mode: "capture-source"` means CaptureSource schedule fields are authoritative.
- `legacyProjectSchedulePresent` flags stale project-owned schedule fields that should not be displayed as active.
- `conflict` reports inconsistent records without inventing a blended schedule.

For the project Camera tab and source configuration modal, use:

```http
GET /api/projects/:projectId/camera-summary
```

This response separates:

- `source.cadence`: physical CaptureSource cadence, timezone, active daily window, and next source capture.
- `source.illumination`: optional outlet association, observed outlet state, and policy.
- `projectSampling`: project-owned sampling interval and next project sample.
- `latestCapture`: latest shared source capture and matching project photo when present.
- `recentOccurrence`: latest scheduled source slot decision, including illumination skips.
- `legacy`: direct-project schedule fields that exist for compatibility but are not the shared source cadence.

The frontend must not derive the shared source cadence from `Project.photoIntervalMinutes` for CaptureSource projects.

## Power Tab

Keep using existing current-state controls and power schedule APIs. Add `power/history` for chart/state-lane ranges. `PowerStateEvent` records observed state transitions only; unchanged telemetry does not create duplicate rows.

## Cameras Tab

Use the canonical fleet camera catalog:

```http
GET /api/hardware/cameras
```

The dashboard should treat coordinator-local, standalone-local, and attached-node cameras identically from the UI perspective. Local versus remote affects execution routing only.

Fleet camera summaries include source-owned schedule details:

- `schedule.intervalMinutes`
- `schedule.timeZone`
- `schedule.dailyWindow.enabled/start/end/crossesMidnight`
- `schedule.nextCaptureAt`

Camera summaries also expose illumination state through `illumination.policy`, `illumination.outletId`, outlet label/key, and observed state/time.

## System Tab

Use:

```http
GET /api/nodes/summary
```

The current installation is returned first with `relationship: "self"`. Attached nodes follow in stable status/display-name order. Each row includes:

- node mode and status;
- service or heartbeat activity;
- camera and sensor counts;
- backend-provided destination URLs for details, cameras, sensors, activity, and system/support when available.

Failed jobs belong in activity/diagnostics, not the primary summary columns.
