# Node Configuration Control Plane

PlantLab node management should distinguish three related but separate facts:

- **Desired configuration**: coordinator-owned intent for sensors, outlets, cameras, and roles.
- **Applied configuration**: the exact revision the edge accepted and loaded atomically.
- **Observed hardware state**: what the node most recently saw when it sampled sensors, refreshed outlets, or inventoried cameras.

Desired configuration is not proof that hardware changed. Observed hardware state is not permission for the edge to invent long-lived configuration.

## Revisions And Ownership

The coordinator owns desired configuration revisions. A revision is immutable once requested and contains the complete slice being applied, not a partial patch. The edge validates the whole revision, writes it atomically, reloads it, and acknowledges either `applied` or `rejected`.

Credentials remain separate from configuration revisions. Node tokens, Kasa secrets, private keys, and host-specific credential files are never stored in revision snapshots.

## Desired, Applied, Observed

Desired sensor configuration includes stable sensor keys, mutable display names, type, GPIO, placement, enabled state, and retired state. Applied sensor configuration is the revision the edge loaded successfully. Observed sensor state is telemetry and diagnostics from sampling that applied configuration.

Camera desired configuration should bind assignments and operator-facing settings to a logical camera, not to `/dev/videoN`. Camera endpoint observations record current V4L2 paths, `/dev/v4l/by-id`, vendor/product/serial, USB path, and confidence evidence. Observed camera inventory may propose reattach candidates, but ambiguous devices require explicit operator selection.

Outlet desired configuration should own behavior policy and provider aliases. Observed outlet state remains authoritative for what is physically on or off.

Historical sensor, camera, outlet, reading, diagnostic, and capture records must be preserved. Retirement hides records from active views and config snapshots by default; it is not deletion.

## Edge Apply Rules

The edge validates a complete revision before promotion:

- reject duplicate active GPIOs;
- reject unsupported sensor types;
- write the new config through temp-file plus rename;
- reload and construct runtimes before acknowledging;
- keep last-known-good config on rejection;
- report rejection reasons to the coordinator.

No partial application: a revision is applied as a whole or not at all.

## Drift, Offline Nodes, And Rollback

Drift exists when desired revision differs from applied revision, when applied status is rejected, or when observed hardware contradicts applied config. Offline nodes keep their last applied and last observed state until they return; the coordinator should not pretend a desired change applied while the node is offline.

Rollback should create a new desired revision copied from the last-known-good applied revision. Do not mutate old revision rows.

## Role Transitions

Role transitions should be jobs owned by the coordinator. A transition from camera-node to greenhouse-node should stage desired role/capability config, deploy compatible runtime if needed, validate the node, then acknowledge the applied role. It should preserve credentials, spools, historical records, and media.

## Browser Safety

Browser routes must expose structured operations only: request inventory refresh, create bounded test capture, update desired config, reattach to a known endpoint, or request a bounded diagnostic. They must never expose arbitrary shell execution, SSH command text, or filesystem paths as user-controlled execution inputs.

## Incremental Implementation Order

1. Authoritative active-config snapshot for sensors, with compatibility fallback for old nodes.
2. Sensor desired/applied configuration and edge acknowledgement.
3. Outlet desired/applied configuration, including explicit behavior policies.
4. Camera desired/applied configuration with logical camera, endpoint observations, and reattach audit.
5. Node-role transition jobs.
6. Project transfer/import.
