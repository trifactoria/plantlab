# Node Configuration Control Plane

PlantLab currently learns much of a node's effective greenhouse configuration
from edge reports:

- `edge-agent.json` on the edge host is merged by `bin/plantlab node attach`.
- Environmental telemetry upserts `NodeSensor` rows by `(nodeId, key)`.
- Power state reports upsert `NodeOutlet` rows by `(nodeId, key)`.
- Camera inventory reports upsert/update camera rows and assignments.

That keeps historical rows available, but it does not yet give the
coordinator an authoritative active configuration revision. A removed sensor
can remain `enabled` in the coordinator because no report explicitly says
"this key is no longer configured." The node summary currently avoids
counting retired sensors with a one-hour last-attempt heuristic in
`src/lib/operations/nodeDetail.ts`. That is a temporary display repair, not
the long-term source of truth.

## Desired, Applied, Observed

Future node configuration should distinguish three related states.

**Desired configuration** is the coordinator-owned intent for a node:
configured sensors, outlets, cameras, roles, schedules, and non-secret
runtime options. Each desired snapshot should have a monotonically
increasing revision, creation timestamp, author/source, and validation
status. Credentials remain separate and must not be embedded in the desired
snapshot.

**Applied configuration** is the edge agent's acknowledged configuration:
the revision it accepted, wrote atomically, loaded, and is currently using.
The edge should reject invalid desired revisions with structured errors
without partially applying them. It should preserve and report the last known
good revision so a bad desired change can roll back without losing durable
spool, credentials, or historical records.

**Observed hardware state** is what the edge actually sees now: sensor read
attempts/classifications, outlet actual state, camera inventory, command
results, and diagnostics. Observed state can drift from desired/applied state
because hardware is unplugged, a Kasa alias is wrong, a camera path moved, a
sensor failed, or the node is offline.

## Revision Flow

1. The coordinator creates a desired configuration snapshot and marks it
   pending for a node.
2. The edge polls for the newest pending revision.
3. The edge validates it locally, including hardware-specific constraints
   that the coordinator cannot fully know.
4. The edge writes the candidate config atomically to a staging path, loads
   it, and performs bounded validation.
5. On success, the edge promotes it to applied, reports the applied revision,
   and resumes normal polling.
6. On rejection, the edge reports a structured rejection and continues using
   the last known good applied revision.
7. The coordinator compares desired, applied, and observed state to surface
   pending, rejected, drifted, stale, and offline statuses.

## Data Model Direction

Add an authoritative active-config snapshot for each node before replacing
existing heuristics. The snapshot should preserve historical sensor, camera,
and outlet rows rather than deleting them. Rows can be linked to first/last
configured revisions so old history remains queryable while active UI views
filter by applied revision.

Recommended incremental order:

1. Authoritative active-config snapshot table and revision metadata.
2. Sensor desired/applied configuration and summary filtering by applied
   revision.
3. Outlet desired/applied configuration, including explicit behavior such as
   `normal` and `pulse-only`.
4. Camera desired/applied configuration and inventory drift reporting.
5. Node-role transition jobs with bounded rollback.
6. Project transfer/import once node state can be reasoned about without
   relying on host-local assumptions.

## Offline, Drift, And Rollback

Offline nodes keep their last applied revision and last observed hardware
state. A newer desired revision can remain pending until the node returns.
The coordinator should not pretend pending desired state is observed state.

Drift should be explicit:

- desired outlet exists but observed alias is missing;
- applied sensor exists but recent attempts fail;
- observed camera appears but is not in desired camera assignments;
- edge reports an older applied revision than the coordinator's desired
  revision.

Rollback should choose a known good applied revision, create a new desired
revision that matches it, and let the edge acknowledge it normally. Avoid
mutating historical revision records in place.

## Security Boundaries

Credentials stay in the existing credential files/secrets flow and are
referenced only by presence/status, never copied into browser-visible
configuration JSON.

Browser routes must not expose arbitrary SSH or shell execution. The
coordinator should offer structured actions with bounded inputs, such as
"apply config revision", "refresh inventory", "test sensor", or "toggle
outlet", and those actions should flow through authenticated coordinator-to-
agent protocols with timeouts and auditable results.
