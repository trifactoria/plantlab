# Hardware UX Architecture Proposal

Audit date: 2026-07-15

This document is an implementation-ready proposal. It does not authorize the refactor stages by itself; each stage should be approved before code changes.

## Operating Principles

- PlantLab is currently a trusted home-lab system.
- Do not add security, authorization, public-hosting, or multi-tenant restrictions unless explicitly requested later.
- Coordinator and all attached nodes may have cameras and sensors.
- All fleet hardware remains manageable through the coordinator.
- Local versus remote affects execution routing, not user capability.
- User-defined names and configuration always win over hardware reports.
- Inventory must never overwrite user-owned values.
- Camera quality may not be silently downgraded persistently.
- Transient sensor misses are not immediate sustained failures.
- Hardware UI should use reusable picker, summary card, drawer, action bar, and detail-page patterns.
- Do not create additional selectors or configuration forms when a canonical reusable component exists.

## Canonical Fleet Camera Contract

The backend should expose one fleet-wide camera summary for coordinator, standalone, and attached-node cameras. The UI should not need to know whether capture executes locally or through a node queue.

```ts
type FleetCameraSummary = {
  id: string;
  stableId: string;
  displayName: string;
  reportedName: string | null;
  node: {
    id: string;
    name: string;
    role: string;
    online: boolean;
    capabilities: string[];
  };
  available: boolean;
  enabled: boolean;
  retired: boolean;
  status: "available" | "unavailable" | "disabled" | "retired" | "node-offline";
  captureSourceId: string | null;
  assignmentId: string | null;
  endpoint: {
    devicePath: string | null;
    usbPath: string | null;
    usbPort: string | null;
    physicalPath: string | null;
  };
  currentMode: {
    width: number;
    height: number;
    inputFormat: string;
    frameRate: string | null;
  } | null;
  supportedModes: Array<{
    width: number;
    height: number;
    inputFormat: string;
    frameRates: string[];
  }>;
  orientation: {
    rotation: 0 | 90 | 180 | 270;
    flipHorizontal: boolean;
    flipVertical: boolean;
  };
  schedule: {
    enabled: boolean;
    intervalMinutes: number | null;
    nextCaptureAt: string | null;
  } | null;
  reliability: {
    warmupFrames: number | null;
    warmupSeconds: number | null;
    captureAttempts: number | null;
    fallbackMode: {
      width: number;
      height: number;
      inputFormat: string | null;
      frameRate: string | null;
      attempts: number;
    } | null;
    persistentFallbackAllowed: false;
  };
  lastCaptureAt: string | null;
  lastCaptureStatus: string | null;
  lastCaptureFallbackUsed: boolean | null;
  configurationUrl: string;
  detailsUrl: string;
  diagnosticsUrl: string;
};
```

Contract notes:

- `displayName` is user-owned.
- `reportedName` is hardware-owned.
- Raw `devicePath` is diagnostic metadata, not the picker label.
- `currentMode` is the configured mode, not the last fallback mode.
- A temporary fallback can be reported in `lastCaptureFallbackUsed`, but it must not replace `currentMode`.

## Canonical Fleet Sensor Contract

```ts
type FleetSensorSummary = {
  id: string;
  key: string;
  displayName: string;
  reportedName: string | null;
  node: {
    id: string;
    name: string;
    role: string;
    online: boolean;
    capabilities: string[];
  };
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
  configuredActive: boolean;
  retired: boolean;
  desiredConfigRevision: number | null;
  appliedConfigRevision: number | null;
  configState: "applied" | "pending" | "rejected" | "unknown";
  currentReading: {
    capturedAt: string;
    temperatureC: number | null;
    humidityPct: number | null;
    classification: string;
  } | null;
  health: {
    state: "healthy" | "intermittent" | "degraded" | "failed" | "node-offline";
    reason: string | null;
    lastValidAt: string | null;
    recentSuccessCount: number;
    recentFailureCount: number;
    consecutiveFailures: number;
    failureDurationSeconds: number | null;
  };
  lastDiagnostic: {
    capturedAt: string;
    code: string | null;
    message: string | null;
    classification: string;
  } | null;
  configurationUrl: string;
  detailsUrl: string;
  historyUrl: string;
};
```

Contract notes:

- `displayName` and `placement` are user-owned configuration values.
- Hardware reports may update observed GPIO/driver diagnostics but must not overwrite display values directly.
- `health.state` is calculated by a canonical evaluator, not a raw latest classification.

## Shared UI Primitives

These primitives should be small and composable, not one generic component with many type checks.

| Component | Purpose | Required props | Boundary | Replaces |
|---|---|---|---|---|
| `HardwarePicker` | grouped single or multi select with stable keyboard/mobile behavior | items, selected IDs, grouping label, render option, disabled reason | client | page-specific select/radio shells |
| `HardwarePickerOption` | consistent option layout | display name, node, status, secondary metadata | client | custom option rows |
| `HardwareSummaryCard` | selected-hardware context after picker | title, status, node, config summary, children actions | server or client shell | page-specific selected state panels |
| `HardwareStatusBadge` | shared status vocabulary | status, label override | server/client | ad hoc badges |
| `HardwareActionBar` | consistent Configure/Test/View actions | action descriptors and pending states | client | scattered buttons |
| `HardwareConfigDrawer` | contextual common configuration | title, open state, form content, save/cancel | client | page-specific inline config blocks |
| `HardwareDetailsLayout` | diagnostic detail page frame | breadcrumbs, title, status, tabs/sections | server layout plus client controls | node-specific detail wrappers |
| `HardwareEmptyState` | no configured hardware | message and primary action | server/client | dashed empty cards |
| `HardwareUnavailableState` | selected but unavailable/retired/offline | status, recovery links | server/client | inconsistent warning cards |

## Camera Components

| Component | Purpose | Props | Boundary | API contract | Replacement targets | Select mode | Mobile/navigation |
|---|---|---|---|---|---|---|---|
| `CameraPicker` | choose a fleet camera/source by display name, grouped by node | `cameras`, `value`, `onChange`, `includeUnavailable`, `usageContext` | client | `FleetCameraSummary[]` | `CaptureSourceSelect`, direct camera radio cards, source selectors | single | full-width select/list on mobile; node group headers |
| `CameraSummaryCard` | show selected camera, node, mode, availability, last capture | `camera`, `actions`, `compact` | server/client | `FleetCameraSummary` | project camera setup summaries, settings summaries, node camera cards | n/a | action bar wraps to large tap targets |
| `CameraConfigDrawer` | edit common camera/source/assignment settings | `camera`, `initialConfig`, `onSave` | client | fleet config GET/PATCH | inline assignment form, capture-source edit panels | n/a | drawer from bottom on mobile |
| `CameraModeEditor` | select supported mode without silent downgrade | `supportedModes`, `value`, `onChange`, `fallback` | client | supported modes from summary/detail | raw width/height/input format inputs | n/a | segmented format, mode select |
| `CameraScheduleEditor` | edit source/direct schedule consistently | schedule value, owner type | client | schedule PATCH contract | duplicated schedule fields | n/a | compact frequency/date controls |
| `CameraTestCaptureAction` | queue or run test capture by routing policy | `camera`, `onResult` | client | canonical test-capture operation | node test, source test-frame/test-capture buttons | n/a | shows queued/running/result |
| `CameraDiagnosticsPanel` | endpoint, stable ID, formats, job history | `cameraId` | server/client | detail endpoint | raw diagnostic sections in management cards | n/a | full detail page, not picker |

## Sensor Components

| Component | Purpose | Props | Boundary | API contract | Replacement targets | Select mode | Mobile/navigation |
|---|---|---|---|---|---|---|---|
| `SensorPicker` | choose one fleet sensor | `sensors`, `value`, `onChange`, `includeUnavailable` | client | `FleetSensorSummary[]` | detail/link selectors | single | node grouped |
| `SensorMultiPicker` | choose project sensors in sequence | `sensors`, `selectedIds`, `onChange` | client | `FleetSensorSummary[]` | New Project checklist, Project Settings link UI | multi | checkbox rows with summary |
| `SensorSummaryCard` | selected sensor current reading and health | `sensor`, `actions`, `compact` | server/client | `FleetSensorSummary` | greenhouse/project/detail cards | n/a | large tap targets |
| `SensorConfigDrawer` | edit display name, placement, GPIO, enabled/retired | `sensor`, `desiredConfig`, `onSave` | client | sensor config revision contract | node sensor inline draft forms | n/a | bottom drawer on mobile |
| `SensorTestAction` | run bounded sensor test command | `sensor`, `attempts`, `interval` | client | `SensorTestCommand` API | detail/management test buttons | n/a | pending/result display |
| `SensorHealthCard` | explain canonical health state | `health`, `lastDiagnostic` | server/client | health evaluator output | ad hoc latest-classification warnings | n/a | short reason plus detail link |
| `SensorHistoryCard` | metric chart with auto-domain | `series`, `range`, `visibleSeries` | client | metric history API | `TimeSeriesCard` callers after enhancement | n/a | range selector and legend remain compact |

## Interaction Standard

Normal selection flow:

1. Dropdown or compact grouped picker.
2. Selected summary card.
3. Configure, Test, and View Details actions.
4. Drawer for common changes.
5. Full detail page for diagnostics/history.

Display rules:

- User-defined display names are primary.
- Node name is visible in every picker option and summary.
- Hardware names, raw device paths, USB paths, GPIOs, stable IDs, and endpoint evidence are secondary diagnostic details.
- Unavailable hardware remains selectable when already configured and clearly explains why it cannot currently capture or read.

## Navigation Proposal

Recommended fleet routes:

```text
/nodes/:node
/nodes/:node/cameras
/nodes/:node/cameras/:camera
/nodes/:node/sensors
/nodes/:node/sensors/:sensor

/projects/:project
/projects/:project/settings
/projects/:project/camera
/projects/:project/environment
```

Navigation behavior:

- Use one breadcrumb component on project and node hardware pages.
- Keep common configuration in drawers so users do not lose project/settings form context.
- Use deep-linkable detail pages for diagnostics, endpoint history, sensor history, job history, and raw evidence.
- Use `returnTo` parameters only when a workflow starts from a modal/drawer and should return to a specific project context.
- Project pages should link to selected camera/sensor detail pages without changing the selected hardware.

## Chart Auto-Domain Design

Add a shared domain utility that accepts visible values, not raw chart props:

```ts
type MetricDomainOptions = {
  physicalMin?: number;
  physicalMax?: number;
  minimumSpan: number;
  paddingRatio: number;
  roundingStep: number;
};

type MetricDomainResult = {
  domain: [number, number];
  ticks: number[];
  empty: boolean;
};

function calculateMetricDomain(
  values: Array<number | null | undefined>,
  options: MetricDomainOptions,
): MetricDomainResult;
```

Requirements:

- Inspect only currently visible series.
- Ignore null/gap points.
- Calculate min and max from visible values.
- Add proportional padding, then enforce a minimum span.
- Recompute when range or series visibility changes.
- Clamp humidity to physical 0-100 only after calculating a useful visible range; do not show full 0-100 unless the data needs it.
- Do not clamp temperature to zero.
- Handle one-value and flat series by expanding around the value.
- Handle empty data with a stable fallback and `empty=true`.
- Produce stable human-friendly ticks by rounding to `roundingStep`.

Suggested defaults pending approval:

- Temperature Fahrenheit: `minimumSpan=6`, `paddingRatio=0.12`, `roundingStep=2`.
- Temperature Celsius: `minimumSpan=3`, `paddingRatio=0.12`, `roundingStep=1`.
- Humidity: `physicalMin=0`, `physicalMax=100`, `minimumSpan=10`, `paddingRatio=0.1`, `roundingStep=5`.

## Sensor Health Design

Create one evaluator used by ingestion summaries, node summaries, cards, project panels, detail pages, and charts.

```ts
type SensorHealthInput = {
  nodeOnline: boolean;
  enabled: boolean;
  configuredActive: boolean;
  retired: boolean;
  now: Date;
  samplingIntervalSeconds: number | null;
  lastAcceptedAt: Date | null;
  lastAttemptAt: Date | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  consecutiveFailures: number;
  consecutiveRejects: number;
  failureDurationSeconds: number | null;
};

type SensorHealthThresholds = {
  intermittentFailureCount: number;
  degradedConsecutiveFailures: number;
  degradedNoSuccessSeconds: number;
  failedNoSuccessSeconds: number;
};

function evaluateSensorHealth(
  input: SensorHealthInput,
  thresholds: SensorHealthThresholds,
): FleetSensorSummary["health"];
```

Proposed states:

- `node-offline`: node is offline or has no recent heartbeat.
- `healthy`: latest accepted reading is recent and failures are below intermittent threshold.
- `intermittent`: recent failures exist, but there has also been a recent success.
- `degraded`: no accepted reading for a sustained window or several consecutive failures.
- `failed`: long failure duration, driver unavailable, or explicit repeated test failure.

Suggested default direction, requiring user approval:

- Do not show sustained degraded/failed for one missed sample.
- Use a three-to-five-minute sustained window before bright failure states for normally sampled DHT22 sensors.
- Derive windows from sampling interval when possible, for example `max(3 * interval, 180 seconds)` for degraded and a longer multiple for failed.

## Incremental Refactor Plan

### Stage A - Data Ownership Correction

Codex tasks:

- Add additive fields for camera `displayName`/`reportedName` and sensor `displayName`/`reportedName` or equivalent.
- Backfill display fields from current names without deleting history.
- Stop inventory from overwriting display fields.
- Normalize display fallback helpers.
- Add tests for inventory preserving user-owned fields.

Claude tasks:

- Review migration semantics and user-facing naming copy.
- Check edge cases for existing capture sources and old camera identities.

Migration risk:

- Medium. User-visible names can change if fallback order is wrong.

Tests:

- Unit tests for inventory, reattach, telemetry ingest, desired/applied config sync.
- Migration/backfill test on isolated DB.

Live verification:

- Read-only before migration; backup before live migration.
- Confirm renamed camera/sensor values survive heartbeat/inventory after migration.

Rollback:

- Additive fields allow code rollback while old `name` remains populated.

Dependencies:

- None.

### Stage B - Fleet Summary Contracts

Codex tasks:

- Add camera catalog and sensor catalog server functions.
- Include normalized status, node context, current config, URLs, and action availability.
- Characterize existing API response shapes before replacing them.

Claude tasks:

- Validate contract names and UI vocabulary against product goals.

Migration risk:

- Low. Read-only contracts.

Tests:

- Unit tests for summary serialization and status mapping.

Live verification:

- Compare catalog output against `plantlab`, `greenhouse-zero`, `bokchoy`, and standalone `xps`.

Rollback:

- Keep old endpoints until pages migrate.

Dependencies:

- Stage A is preferred so display fields are correct.

### Stage C - Backend Operation Normalization

Codex tasks:

- Define one camera configuration contract.
- Define one camera test-capture operation that routes locally or queues remotely.
- Define one sensor configuration contract based on desired/applied revisions.
- Define one sensor test operation wrapper.
- Remove production-mode UI management restrictions while preserving execution checks.

Claude tasks:

- Review operation names, UX copy, and failure explanations.

Migration risk:

- Medium. Capture and config paths are user-visible.

Tests:

- Unit tests for route selection, local/remote routing, unavailable hardware, and command lifecycle.

Live verification:

- Read-only route checks first; run real captures only with explicit approval and restore state.

Rollback:

- Keep old operations behind wrappers until pages migrate.

Dependencies:

- Stage B contracts.

### Stage D - Reusable UI Primitives

Codex tasks:

- Build `HardwarePicker`, summary card, status badge, action bar, drawer, detail layout.
- Build camera and sensor compositions on top.
- Keep primitives accessible and mobile-friendly.

Claude tasks:

- Review component API, language, and interaction consistency.

Migration risk:

- Low to medium. Visual/interaction changes can be staged.

Tests:

- Component tests where available, Playwright smoke for migrated pages, screenshot review for visual changes.

Live verification:

- Browser verify coordinator, standalone, mobile viewport, and unavailable hardware states.

Rollback:

- Components can coexist with old pages until migration is complete.

Dependencies:

- Stage B contracts.

### Stage E - Page Migration

Recommended order:

1. New Project.
2. Project Settings.
3. Project Camera Setup.
4. Node Cameras.
5. Node Sensors.
6. Project Environment.
7. Home dashboard.

Codex tasks:

- Replace one page at a time.
- Preserve existing behavior until each page's routing/config behavior is explicitly changed.
- Remove obsolete selectors only after all callers migrate.

Claude tasks:

- Review each page for workflow clarity and missing operator guidance.

Migration risk:

- Medium. Project creation/settings are common workflows.

Tests:

- Focused Playwright tests per page plus existing unit coverage.

Live verification:

- Browser smoke with live read-only data; avoid changing hardware state unless approved.

Rollback:

- Each page migration should be one focused commit.

Dependencies:

- Stages B-D.

### Stage F - Capture Reliability

Codex tasks:

- Converge local, source, scheduled, and remote captures on one capture engine contract.
- Validate requested 1080p output dimensions and image integrity.
- Retry invalid captures.
- Allow configured temporary fallback for individual captures only.
- Record fallback use without changing configured mode.
- Add scheduled-capture timing tests.

Claude tasks:

- Review operator-facing fallback and failure language.

Migration risk:

- High. Capture behavior and schedules are core workflows.

Tests:

- Unit tests for mode selection, validation, retry, fallback, job lifecycle.
- Edge-agent tests for Python capture behavior.
- Integration tests with isolated media directories.

Live verification:

- Requires explicit approval for real test captures.
- Preserve current schedules and restore any temporary state.

Rollback:

- Feature flag the new engine per execution path until proven.

Dependencies:

- Stage C operation normalization.

### Stage G - Sensor Health And Charts

Codex tasks:

- Implement `evaluateSensorHealth`.
- Replace direct latest-classification badges.
- Implement `calculateMetricDomain`.
- Update `TimeSeriesCard`/`MetricChart` to use visible-series domains.

Claude tasks:

- Tune health copy and threshold defaults with user approval.

Migration risk:

- Medium. Dashboards will look different.

Tests:

- Unit tests for health thresholds, offline nodes, intermittent misses, flat/empty charts, hidden series, humidity clamp.

Live verification:

- Compare live greenhouse cards against recent diagnostics without changing sensors.

Rollback:

- Keep old latest-classification available as diagnostic detail.

Dependencies:

- Stage B sensor summary contract.

## Proposed AGENTS.md Addition

Do not apply blindly while `AGENTS.md` is dirty. Proposed text:

```md
## Hardware product contract

PlantLab is currently a trusted home-lab system. Do not add security,
authorization, public-hosting, or multi-tenant restrictions unless explicitly
requested for a later project.

Coordinator and all attached nodes may have cameras and sensors. All fleet
hardware must remain manageable through the coordinator. Local versus remote
affects execution routing only; it must not remove normal management,
configuration, testing, scheduling, or diagnostics UI.

User-defined names, labels, schedules, selected modes, warm-up, retry, fallback,
assignment, placement, and project-specific configuration always win over
hardware reports. Inventory may update reported names, endpoints, device paths,
capabilities, supported formats, availability, and last-seen timestamps, but it
must never overwrite user-owned values.

Camera quality may not be silently downgraded persistently. If a user selects
1920x1080, capture should request and validate 1920x1080. A configured temporary
fallback may be used for an individual capture and must be reported, but it must
not replace the configured mode without explicit user action.

Transient sensor misses are normal. Do not make one failed DHT22 read look like
a sustained hardware failure. Sensor health should be calculated through the
canonical evaluator and distinguish healthy, intermittent, degraded, failed, and
node-offline states.

Hardware UI should use canonical reusable picker, selected-summary card,
configuration drawer, action bar, status badge, and detail-page patterns. Do not
create additional page-specific selectors or configuration forms when a canonical
component exists.
```

## Proposed CLAUDE.md Addition

Do not apply blindly while `CLAUDE.md` is dirty. Proposed text:

```md
## Hardware architecture guidance

For camera and sensor work, follow the current hardware product contract:

- PlantLab is a trusted home-lab system unless the user explicitly scopes a
  security/public-hosting project.
- Any installation may host cameras and sensors, including the coordinator,
  standalone installs, camera nodes, greenhouse nodes, and mixed-capability
  nodes.
- The coordinator must manage all fleet hardware. Local/remote only changes
  where operations execute.
- User-owned display names and configuration always win over reported hardware
  defaults.
- Inventory must not overwrite user-owned values.
- Do not silently persist camera quality downgrades.
- Treat isolated DHT22 misses as noise until canonical health thresholds classify
  them as sustained failures.
- Use canonical reusable hardware picker/card/drawer/detail components instead
  of creating new selectors or forms.
```
