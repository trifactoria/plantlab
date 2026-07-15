# PlantLab Hardware Surface Audit

Audit date: 2026-07-15

Scope: repository mapping plus read-only live inspection of `plantlab`, `greenhouse-zero`, `bokchoy`, and local `xps`. No live configuration, schedules, GPIO assignments, camera modes, captures, migrations, or destructive operations were changed.

## Product Contract Used For This Audit

PlantLab is currently a trusted home-lab application. Security, public hosting, multi-tenancy, and authorization are not design goals for this hardware refactor unless requested later.

Any installation can have cameras and sensors: coordinator, standalone installation, camera node, greenhouse node, or mixed-capability node. Coordinator UI should manage all fleet hardware. Local versus remote should affect execution routing only.

User-owned values win over hardware reports. Inventory may update hardware-owned fields such as reported name, endpoint, device path, capabilities, supported formats, availability, and last-seen time. Inventory must not overwrite display names, assignments, schedules, selected modes, warm-up, retry, fallback, placement labels, or project-specific labels.

## Live Evidence

### `xps`

- Local hostname is `xps`; `bin/plantlab node info` reports role `standalone`.
- `plantlab-web.service` was inactive during inspection.
- `plantlab-camera.service` was active and running scheduled direct local captures.
- Local standalone data showed one project using direct local `/dev/video4` with camera name `Logitech BRIO`; no local `CaptureSource` rows were present.
- `ssh xps` was not used because the configured host key did not match the current known host entry. Since the shell was already on `xps`, local read-only inspection was used instead.

### `plantlab`

- Role is `coordinator`; web and camera services were active.
- Web service logs showed `NODE_ENV=production` and `localCameraHardwareEnabled=false`.
- Camera service logs showed scheduled remote `CaptureSource` work queued to `greenhouse-zero`.
- Fleet DB evidence:
  - `bokchoy` is online and currently reports an available `/dev/video0` camera with a newer stable ID, while existing capture sources remain attached to older unavailable logical camera rows.
  - `greenhouse-zero` reports three available USB cameras plus older unavailable/retired rows from previous identities.
  - Several `CaptureSource.cameraDevice` values differ from the active assignment's current `NodeCamera.devicePath`, showing that source camera fields are stale metadata in practice.
  - Recent remote jobs include validation/fallback metadata, but older jobs have null validation/effective mode fields.
- Sensor DB evidence:
  - Four active greenhouse sensors had latest `accepted` telemetry.
  - Recent diagnostics included isolated `failed`, `rejected`, and hard-bound events, confirming transient DHT22 misses are normal.
  - An obsolete `greenhouse-ambient` row remains enabled but `configuredActive=false` with latest `failed`, showing why active filtering is needed.

### `greenhouse-zero`

- Python edge agent service was active.
- `plantlab-edge config show` reported role `greenhouse-node`, capabilities `camera`, `temperature`, `humidity`, `relay`, `fan`, `light`, `pump`, four configured DHT22 sensors, applied sensor config revision 5, and a cached camera inventory of three cameras.
- `plantlab-edge doctor` reported overall healthy with 4 healthy sensors and 0 failing sensors.

### `bokchoy`

- TypeScript camera-node service was active.
- Node info reported role `camera-node`.
- Camera inventory reported `/dev/video0` `Integrated Webcam (1.0)` with a stable ID that differs from the old assigned coordinator camera row.
- Recent logs contained transient coordinator fetch failures, but the coordinator had later heartbeat/inventory timestamps.

## Camera UI Surfaces

| Surface | Route | Component | Data API/server function | Selection identity | Fields displayed | Configuration actions | Local/remote branching | Duplicated logic | Known inconsistency |
|---|---|---|---|---|---|---|---|---|---|
| New Project | `/` | `ProjectForm`, `CaptureSourceSelect` | `POST /api/projects`, `GET /api/capture-sources/available` | `captureSourceId` | source name/logical camera name, node group, resolution, availability | select only | none in picker; project API creates `ProjectViewport` | capture-source picker separate from camera setup and node management | no selected summary, test, configure, diagnostics, or current mode context |
| Project Settings | `/projects/:projectId/settings` | `ProjectSettingsForm`, `ProjectCaptureModeSection`, `CameraSelect`, `CaptureSourceSelect` | `PATCH /api/projects/:id`, `GET /api/cameras`, `GET /api/capture-sources/available` | raw `cameraDevice` for direct local; `captureSourceId` for fleet source | raw local device/name, source name, source node/availability | change capture mode and source | direct-local option hidden unless `localCameraHardwareEnabled()` or already selected | duplicates New Project picker and Camera Setup mode selection | uses two incompatible identities and exposes raw device paths |
| Project Camera Setup | `/projects/:projectId/camera` | `CameraSetupPanel` | project camera APIs, capture-source APIs, camera format/control/profile APIs | raw `cameraDevice`, `captureSourceId`, `cameraProfileId` | selected local device, source, schedule, controls, formats, profiles, preview/status | save mode/source, schedule, preview, control edits, profile edits, autofocus, resolution compare, verification | local direct controls gated by `localCameraHardwareEnabled()` | largest overlapping camera configuration page | mixed direct-local and shared-source configuration; no compact selected fleet summary |
| Project Dashboard Capture | `/projects/:projectId` | `CapturePhotoButton`, project metadata cards | `POST /api/projects/:id/photos/capture`, `captureProjectManually` | active viewport source, else raw `Project.cameraDevice` | project `cameraDevice`; separate capture-origin card for source | manual capture | button hidden when local camera hardware is disabled, even though backend can queue remote jobs first | capture source selection state repeated on project page | remote fleet capture affordance can disappear on coordinator |
| Capture Source List | `/capture-sources` | page list, `CaptureSourceForm`, `CameraSelect` | `GET/POST /api/capture-sources`, `GET /api/cameras` | raw local `cameraDevice` on create | source name, camera name, raw device, schedule | create source and schedule | creation form depends on local camera discovery | another camera selector and schedule form | cannot create an attached-node source through the same fleet picker pattern |
| Capture Source Detail | `/capture-sources/:sourceId` | `ShelfLayoutEditor` | `GET/PATCH /api/capture-sources/:id`, test-frame/test-capture APIs, viewport APIs, format APIs | `captureSourceId`, viewport/project IDs, raw source camera fields | source name, device/name, schedule, projects/viewports, preview | edit source, schedule, viewports, test frame/capture | entire page replaced by local-only warning when `localCameraHardwareEnabled()` is false | duplicates capture/test/config behaviors from project camera setup | production/local flag hides remote capture-source management |
| Node Camera Management | `/nodes/:nodeName/cameras` | `CameraManagementPanel`, `AssignmentConfigForm`, `ReattachCameraDialog` | `GET/PATCH /api/nodes/:node/cameras`, assignment PATCH/test, reattach APIs | `nodeCamera.id`, `assignment.id`, `endpoint.id` | display name, raw device path, stable IDs, endpoint history, USB paths, formats, assignment mode, source link, recent job | refresh inventory, rename, enable/disable, retire/restore, configure assignment, test capture, reattach | execution is remote job queue for attached nodes | unique rich card implementation, not reused elsewhere | raw device/identity details are primary instead of diagnostics-only; warm-up/retry/fallback not fully surfaced in UI |
| Node Detail | `/nodes/:nodeName` | `NodeDetailPanel`, `GreenhousePanel` | node detail operations and environment APIs | node name, sensor keys, outlet keys | node status, capability summaries, links, greenhouse cards | links to management pages, power controls where present | role/capability drives panels | status and cards separate from management pages | camera selection/config details are not reusable |
| Legacy Camera List | component only | `CameraListPanel` | node camera APIs | camera ID/source ID | node camera rows, raw device path, source link | link only | none | overlaps node camera list | older read-only surface still exposes raw device as normal detail |
| Screenshots/fixtures | Playwright/dev data | screenshot specs, fixture pages, `tests/helpers/devData.ts` | fixture data and seeded test DB | mix of source IDs, raw devices, sensor IDs | mock camera/source/sensor values | screenshot-only | test-only flags | fixtures encode current UI states | useful for visual regression after page migration |

## Sensor UI Surfaces

| Surface | Route | Component | Data API/server function | Selection identity | Fields displayed | Configuration actions | Local/remote branching | Duplicated logic | Known inconsistency |
|---|---|---|---|---|---|---|---|---|---|
| New Project | `/` | `ProjectForm`, `ProjectSensorChecklist` | `GET /api/sensors/available`, `POST /api/projects/:id/sensors` | `sensor.id` | sensor name, node name | multi-select only | none | separate from settings bindings UI | no health, placement, diagnostics, or configuration affordances |
| Project Settings | `/projects/:id/settings` | `ProjectSensorBindingsPanel` | project sensor binding APIs, `GET /api/sensors/available` | `binding.id`, `sensor.id` | label, role, node/sensor, enabled state | link, unlink, relink, edit label/role | none | duplicates New Project sensor selection | binding labels are project-owned but picker does not show health/config context |
| Project Environment | `/projects/:id` | `ProjectEnvironmentPanel`, `TimeSeriesCard` | project metrics history API | project binding IDs | linked sensors, status badge, latest temp/humidity, charts | range selection, hide series in chart | none | chart/status logic reused but health is still latest-classification based | one transient failed latest event can show failure until next accepted event |
| Greenhouse Cards | `/nodes/:nodeName`, `/` coordinator panel | `GreenhousePanel`, `GreenhouseCharts` | `GET /api/nodes/:node/environment`, metric history APIs | fixed sensor keys and node name | four cards, latest reading, status, chart range | range selection, power controls nearby | node capability/role controls rendering | separate card layout from project and detail pages | status is direct latest classification; hardcoded greenhouse slots |
| Node Sensor Management | `/nodes/:nodeName/sensors` | `SensorManagementPanel` | environment, node, sensor config, sensor test APIs | sensor key plus draft entry index | desired config, applied config, latest reading, diagnostic, enabled/retired | add, rename, GPIO, placement, enable/disable, retire/restore, apply config, run test | node selected by route; commands queued to node | independent forms/status badges | desired/applied rows and telemetry rows share name/GPIO/placement fields |
| Sensor Detail | `/nodes/:nodeName/sensors/:sensorKey` | `SensorDetailPanel`, `TimeSeriesCard` | sensor detail, metric history, sensor test APIs | `sensor.key` | latest reading, classification, diagnostics, test state, charts | run sensor test, range selection | node selected by route; command queued to node | detail-specific health card | latest classification maps directly to failed/degraded language |
| Sensor List | component only | `SensorListPanel` | environment APIs | sensor key | active sensor cards, GPIO, placement, last accepted/diagnostic | link to detail | none | overlaps greenhouse cards and management cards | active filtering is heuristic and local to display code |
| Photo Context | photo/project pages | `PhotoEnvironmentCard` | nearest-reading query | photo ID plus sensor binding | nearest readings around photo time | read-only | none | separate rendering of sensor summaries | not tied to canonical fleet sensor summary |

## Duplicated Components And Logic

### Camera Selection

- `CameraSelect`: local V4L2 discovery only, value is raw `device`, displays `name - /dev/videoX`, supports saved fallback options, exposes raw device paths, no fleet/availability/actions.
- `CaptureSourceSelect`: fleet-ish source picker, value is `captureSourceId`, groups by node, shows availability/retired and resolution, no configure/test/diagnostics actions.
- `ProjectCaptureModeSection`: combines direct-local radio choices and capture-source selection; embeds mode-specific policy.
- `CameraSetupPanel`: repeats direct-local and capture-source selection with preview, schedules, profiles, and controls.
- `CameraManagementPanel`: rich node camera card selector/manager by `nodeCamera.id`; not reusable in project workflows.
- `CaptureSourceForm` and `ShelfLayoutEditor`: create/configure shared sources through local raw devices and source-specific controls.

Replaceability:

- `CameraSelect` should become a diagnostic/direct-local implementation detail after fleet camera catalogs exist.
- `CaptureSourceSelect` can be replaced by `CameraPicker` or source-aware `CameraPicker` mode.
- Node camera cards should donate diagnostics/actions to `CameraSummaryCard` and `CameraDiagnosticsPanel`.
- Page-specific radio cards should collapse to shared picker plus selected summary.

### Sensor Selection

- `ProjectSensorChecklist`: project creation multi-select by `sensor.id`; minimal context.
- `ProjectSensorBindingsPanel`: link/edit binding workflow by `sensor.id` and `binding.id`.
- `SensorManagementPanel`: desired/applied config editor by sensor key.
- `SensorListPanel`, `GreenhousePanel`, `ProjectEnvironmentPanel`, and `SensorDetailPanel`: separate status/card presentations of the same sensor facts.

Replaceability:

- New Project and Project Settings can share `SensorMultiPicker`.
- Node and project cards can share `SensorSummaryCard`.
- Desired/applied configuration needs a dedicated `SensorConfigDrawer`, not page-specific forms everywhere.

### Status Calculations

- Camera availability is computed from combinations of `NodeCamera.available`, `enabled`, `retiredAt`, assignment activity, and capture-source active state in node camera APIs, capture-source availability APIs, schedulers, and manual capture.
- Camera active/retired state is displayed in node management and capture-source pickers with different labels.
- Sensor state is mostly `latestClassification` mapped through `sensorStatusTone`, plus active filtering in `filterCurrentlyActiveSensors` and config revision state in `SensorManagementPanel`.
- Node health appears in coordinator dashboards, node detail, and command protocols with different summaries.
- Configuration drift is calculated in sensor config pages by comparing desired/applied revisions; cameras do not have an equivalent reusable drift status.
- Pending command state is separate for power, sensor tests, and camera jobs.

The same user concept, "is this usable right now?", is therefore page-specific for both cameras and sensors.

### Charts

- Reusable pieces exist: `TimeSeriesCard`, `MetricChart`, `RangeSelector`, and metric-history normalization/gap insertion.
- `MetricChart` does not define a Y-axis domain. It delegates to Recharts defaults instead of inspecting visible values.
- Hidden series are hidden at line-render time. There is no reusable visible-series min/max calculation.
- Gap handling is centralized through null points in `insertGapBreaks`.
- Fahrenheit conversion is repeated at the panel level (`GreenhouseCharts`, `ProjectEnvironmentPanel`, sensor detail).
- There is no shared domain policy for humidity physical bounds, temperature padding, flat series, empty data, or friendly tick rounding.

## Current Data Model Ownership

### Cameras

- `NodeCamera`: persistent logical camera observed on a node. Today it stores both hardware-owned inventory (`devicePath`, `stableId`, `formatsJson`, USB metadata, availability) and user-facing `name`.
- `NodeCameraEndpoint`: observed endpoint/path for a logical camera. It is hardware-owned evidence and history.
- `NodeCameraAssignment`: coordinator-side binding from a logical node camera to a `CaptureSource`, including selected capture mode, frame rate, warm-up, retry, fallback, serialization, and active state.
- `CaptureSource`: shared source/shelf/frame concept used by one or more projects. It owns source display name, schedule, orientation/crop space dimensions, and project fan-out.
- `ProjectViewport`: project selection of a `CaptureSource` plus crop/viewport data.
- `Project.captureSource` relationship: active project-to-source link through `ProjectViewport`, not a direct `Project` FK.
- `AgentCaptureJob`: queued/claimed/completed remote capture work for node assignments, including effective mode, validation, fallback, and timing.
- `SourceCapture`: full-frame shared capture artifact after local or remote ingest.
- `Photo`: project photo derived from direct capture, upload, scan, or source fan-out.
- `CameraProfile`: direct-local saved mode/control profile; overlaps with capture source and assignment mode fields.

What is physical/logical camera: `NodeCamera`.

Current endpoint: `NodeCameraEndpoint` plus denormalized `NodeCamera.devicePath`.

User configuration: split across `CaptureSource`, `NodeCameraAssignment`, `CameraProfile`, `Project`, and `ProjectViewport`.

Project selection: `ProjectViewport` for shared sources; legacy `Project.cameraDevice` for direct local.

Capture scheduling: `CaptureSource` for shared sources; `Project` for legacy direct local.

Rotation/flips: `CaptureSource`.

Width/height/format/frame rate/warm-up/retry/fallback:

- Direct local: `Project.cameraProfile`/`CameraProfile`, env defaults, and `Project.cameraDevice`.
- Shared local: `CaptureSource.width/height` and profile input format.
- Remote assignment: `NodeCameraAssignment.width/height/inputFormat/frameRate/warmupFrames/warmupSeconds/captureAttempts/fallback*`.

Duplicated/canonical confusion:

- `CaptureSource.cameraDevice`, `cameraName`, `cameraStableId` act as display/provenance metadata but are treated like current values in some UI.
- `NodeCamera.name` is both user display name and agent reported hardware name.
- `NodeCamera.devicePath` is current endpoint metadata but appears as a user-facing identifier.
- Resolution exists in `CameraProfile`, `CaptureSource`, and `NodeCameraAssignment`.

### Sensors

- `NodeSensor`: persistent sensor slot on a node. Today it stores user-ish values (`name`, `placement`), config values (`gpio`, `enabled`, `configuredActive`, revisions), and latest telemetry/health fields.
- `SensorReading`: accepted measurements only.
- `SensorDiagnostic`: rejected/suspect/failed/stale/driver diagnostic events.
- `SensorTestCommand`: bounded queued diagnostic command and result summary.
- `NodeSensorConfigRevision`: coordinator-authored desired/applied sensor configuration snapshot.
- `ProjectSensorBinding`: project selection with project-owned label/role/enabled/degraded fields.

What is physical/logical sensor: `NodeSensor` keyed by `nodeId + key`.

Current observed state: latest fields on `NodeSensor`, plus `SensorReading` and `SensorDiagnostic` history.

Desired/applied config: `NodeSensorConfigRevision` and denormalized revision fields on `NodeSensor`.

Project selection: `ProjectSensorBinding`.

Duplicated/canonical confusion:

- `NodeSensor.name`, `gpio`, and `placement` can be overwritten by telemetry and config sync.
- Project binding label is correctly project-owned but not used by all sensor UIs.
- Health is stored as latest classification and recalculated differently in UI summaries.

## Overwrite Paths And Field Ownership

| Field | Current owner in code | May inventory/telemetry update today? | May user update today? | Proposed canonical owner |
|---|---|---:|---:|---|
| Camera display name | `NodeCamera.name` | Yes | Yes | `NodeCamera.displayName` user-owned |
| Camera reported name | `NodeCamera.name`, endpoint `name` | Yes | No dedicated field | `NodeCamera.reportedName`, `NodeCameraEndpoint.reportedName` |
| Camera endpoint/device path | `NodeCamera.devicePath`, endpoint rows | Yes | No | hardware inventory |
| USB path/port/vendor/product/serial | `NodeCamera`, endpoint rows | Yes | No | hardware inventory |
| Supported formats | `NodeCamera.formatsJson`, endpoint rows | Yes | No | hardware inventory |
| Availability/last seen | `NodeCamera.available/lastSeenAt` | Yes | limited enable/retire separately | hardware inventory |
| Camera enabled/retired | `NodeCamera.enabled/retiredAt` | missing camera marks unavailable only | Yes | user/coordinator |
| CaptureSource name | `CaptureSource.name` | No direct inventory overwrite | Yes | user-owned |
| CaptureSource camera metadata | `CaptureSource.cameraDevice/name/stableId` | attach/reattach/source update can overwrite | Yes via source update | metadata derived from assignment/current endpoint |
| Assignment name | `NodeCameraAssignment.name` | attach may set from source | Yes | user-owned or derived once from source |
| Resolution/mode | `CameraProfile`, `CaptureSource`, `NodeCameraAssignment` | inventory updates supported list, not selected mode | Yes | assignment/source mode config |
| Frame rate | `NodeCameraAssignment.frameRate` | No | Yes through API | assignment config |
| Warm-up/retries/fallback | `NodeCameraAssignment` | No | Yes through API | assignment config |
| Rotation/flips | `CaptureSource` | No | Yes | source/project view config |
| Schedules | `Project`, `CaptureSource` | No | Yes | source or project schedule owner |
| Sensor display name | `NodeSensor.name` | Yes | Yes through desired config | `NodeSensor.displayName` user-owned |
| Sensor reported name | `NodeSensor.name` | Yes | No dedicated field | `NodeSensor.reportedName` |
| Sensor GPIO | `NodeSensor.gpio` | Yes from telemetry/config sync | Yes through desired config | desired/applied config, with diagnostics preserving observed GPIO |
| Sensor placement | `NodeSensor.placement` | Yes from telemetry/config sync | Yes through desired config | user-owned desired config |
| Sensor enabled/retired | `NodeSensor.enabled/retiredAt` | Yes through config sync | Yes | coordinator desired config |

Confirmed camera-name revert:

1. User rename calls `renameNodeCamera`, which updates `NodeCamera.name`.
2. Next inventory calls `updateCameraInventory`.
3. `updateCameraInventory` updates the same `NodeCamera.name` from the agent report.
4. UI display helpers read `NodeCamera.name`, so the user value reverts.

Other overwrite paths:

- `recordCameraEndpoint` overwrites endpoint reported name and path metadata.
- `reattachNodeCamera` updates the logical camera name from the endpoint.
- `attachNodeCamera` updates existing `CaptureSource.cameraDevice`, `cameraName`, and `cameraStableId`.
- `ingestEnvironmentTelemetry` upserts `NodeSensor` and overwrites `name`, `type`, `gpio`, `placement`, `enabled`, and latest health fields.
- `syncDesiredSensorRows` and `syncAppliedSensorRows` overwrite sensor config fields from revision entries.
- Project create/update clears or rewrites legacy project camera fields when mode changes.

## Local, Remote, And Role Branching

| Branch | Locations | Classification | Issue |
|---|---|---|---|
| `NODE_ENV` | `localCameraHardwareEnabled`, Prisma/test helpers | UI visibility, local hardware discovery, testing behavior | production disables local camera UI and sometimes remote management surfaces |
| `PLANTLAB_LOCAL_CAMERA_ENABLED` | `localOnly.ts`, service environment | hardware discovery/UI visibility | valid as execution/discovery flag, invalid when hiding fleet management |
| `PLANTLAB_TEST_LOCAL_CAMERA_UI` | local camera APIs/tests | testing-only behavior | acceptable test shim |
| `localCameraHardwareEnabled()` | project page, settings, camera setup, capture-source detail/test APIs | mixed UI visibility and execution routing | execution routing is valid; hiding management UI is not |
| `standalone`, `coordinator`, `camera-node`, `greenhouse-node` roles | node config, dashboards, services, edge agents | execution routing, hardware discovery, legacy UI grouping | role must not imply exclusive capability |
| runtime capabilities | agent loops, dashboards, service summaries | hardware discovery/execution routing | should be the primary signal for available actions |

Flagged management restrictions:

- Project manual capture button is hidden by local hardware state even when a remote active `CaptureSource` could be queued.
- Capture-source detail can be hidden behind a local-only warning on the coordinator.
- Direct-local UI guards are correct for physical local capture operations, but the same flag should not hide fleet configuration, remote test capture, source layout, or assignment management.

## Capture Paths

| Path | UI action | API/server operation | Job model | Execution host | Identity resolution | Capture implementation | Validation | Upload/ingest/photo | Status reporting |
|---|---|---|---|---|---|---|---|---|---|
| Coordinator-local manual capture | Project Capture Photo without active viewport | `POST /api/projects/:id/photos/capture` -> `captureProjectManually` -> `captureProjectPhoto` | `CaptureRun` for scheduled only; manual creates `Photo` directly | coordinator/standalone | `Project.cameraDevice` plus optional `CameraProfile` | `src/lib/camera.ts` ffmpeg direct | command failure only; no dimension validation | writes project photo file and `Photo` | button/API response |
| Attached-node manual test capture | Node camera Test capture | `POST /api/nodes/:node/camera-assignments/:id/test-capture` -> `queueCameraTestCapture` | `AgentCaptureJob` | attached node | `NodeCameraAssignment` and current `NodeCamera` | TS or Python agent ffmpeg/capture engine | agent-side validation where implemented; job records effective mode/fallback | upload to coordinator creates `SourceCapture` | job card/recent job state |
| Project Capture Photo via source | Project Capture Photo with active viewport | `captureProjectManually` | local source: none; remote: `AgentCaptureJob` | coordinator if no assignment, else node | active `ProjectViewport.captureSource`; assignment if present | local `captureSourcePhoto` or remote agent | local source validates dimensions; remote agent validates | local/remote `SourceCapture`, fan-out to `Photo` | response says captured/queued |
| Scheduled CaptureSource capture | camera service tick | `CaptureSourceScheduler` | remote uses `AgentCaptureJob`; local uses scheduler log/source capture | coordinator or attached node | active due `CaptureSource`, active assignment if any | local source engine or remote agent | local source validates dimensions; remote agent validates | `SourceCapture` and fan-out | scheduler logs and job/source rows |
| Legacy direct-local project capture | camera service tick | `CaptureScheduler` -> `captureProjectPhoto` | `CaptureRun` | coordinator/standalone | `Project.cameraDevice` | `src/lib/camera.ts` ffmpeg direct | command failure only; no dimension validation | `Photo` | `CaptureRun` |
| Shared CaptureSource fan-out | after source capture | source capture service fan-out | no separate capture job | coordinator ingest | `ProjectViewport` rows | crop/transform source frame | depends on source capture validation | creates project `Photo` rows | source capture and project photos |
| Camera inventory capture probe | agent inventory/verification | agent camera inventory refresh | none or agent-local probe result | node | discovered endpoint/stable ID | agent probe/ffmpeg/v4l2 tooling | probe-specific; not same as capture validation | inventory rows only | inventory diagnostics/status |

Differences that block reliability:

- Direct local project capture and source capture use different server functions and validation.
- Remote captures use job payload settings from assignment; direct local uses project/profile/env settings.
- Warm-up/retry/fallback are assignment-level for remote jobs but not equivalent in direct local project capture.
- `CaptureSource.width/height` are transformed working dimensions; assignment width/height are raw capture dimensions.
- Scheduler and manual paths report queued/captured/succeeded differently.

## Chart-Domain Root Cause

There is no single chart-domain function. The chart layer delegates Y-axis selection to Recharts and does not calculate bounds from currently visible, non-null series points. As a result, behavior is implicit and inconsistent with the desired product rule:

- hidden series are not part of rendered lines but are not part of any explicit visible-domain calculation;
- null gap points are handled for drawing but not part of a reusable domain policy;
- humidity has no shared physical clamp/padded visible range policy;
- temperature has no policy preventing zero-based display when the library chooses it;
- flat, empty, and single-value series are not handled by PlantLab-owned code.

## Sensor-Health Root Cause

The application treats latest classification as health in most UI surfaces. A single latest failed DHT22 read can become a bright failed state until the next accepted reading. There is no canonical evaluator using node online state, last accepted time, recent success/failure counts, consecutive failures, failure duration, and configured sampling interval.

Existing fields make a better evaluator possible: `lastAcceptedAt`, `lastAttemptAt`, `consecutiveFailures`, `consecutiveRejects`, diagnostics history, readings history, node `status`, and sensor config revision state.

## Immediate Defects To Address First

1. `NodeCamera.name` is overwritten by inventory after a user rename.
2. `NodeSensor.name`, `gpio`, and `placement` are overwritten by telemetry/config sync instead of separating user-owned and reported/configured fields.
3. Production/local camera flags hide some fleet management and remote capture surfaces.
4. `bokchoy` has an identity split: an available new camera row and older assigned unavailable camera rows.
5. `CaptureSource.cameraDevice` can be stale relative to active assignment device paths.
6. Direct local capture lacks the same validation/retry/fallback semantics as remote/source capture.
7. Sensor cards use latest failed sample as sustained failure.
8. Charts lack a PlantLab-owned auto-domain policy.

## Questions For Implementation Approval

- Should user camera display names live on `NodeCamera.displayName` with `reportedName` backfilled from current inventory, or should display names be stored per assignment/source only?
- Should source-level width/height remain transformed display dimensions, or should source mode be split into raw capture mode plus orientation-derived display dimensions?
- What should be the default sensor health debounce window: three minutes, five minutes, or derived from sampling interval?
- Should direct-local project capture be migrated into `CaptureSource` immediately, or left as legacy until after fleet summaries exist?
- Should stale `CaptureSource.cameraDevice/name` fields remain as historical provenance or be replaced by assignment-derived display everywhere?
- What is the desired cleanup process for old unavailable camera rows that still have assignments, such as `bokchoy`?
