-- Observed power outlet transitions for chart-aligned state lanes.
-- Backfill policy: one initial event per outlet with a currently observed
-- boolean state, using the latest reliable outlet observation timestamp and
-- source "unknown". Older command rows are not replayed into fabricated
-- transitions.

CREATE TABLE "PowerStateEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "outletKey" TEXT NOT NULL,
    "observedState" BOOLEAN NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "commandId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PowerStateEvent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PowerStateEvent_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "NodeOutlet" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PowerStateEvent_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "PowerCommand" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "PowerStateEvent" (
    "id",
    "nodeId",
    "outletId",
    "outletKey",
    "observedState",
    "observedAt",
    "source",
    "commandId",
    "createdAt"
)
SELECT
    lower(hex(randomblob(16))),
    "nodeId",
    "id",
    "key",
    "actualState",
    COALESCE("stateObservedAt", "updatedAt", "createdAt"),
    'unknown',
    NULL,
    CURRENT_TIMESTAMP
FROM "NodeOutlet"
WHERE "actualState" IS NOT NULL;

CREATE INDEX "PowerStateEvent_nodeId_outletKey_observedAt_idx" ON "PowerStateEvent"("nodeId", "outletKey", "observedAt");
CREATE INDEX "PowerStateEvent_outletId_observedAt_idx" ON "PowerStateEvent"("outletId", "observedAt");
CREATE INDEX "PowerStateEvent_commandId_idx" ON "PowerStateEvent"("commandId");
CREATE INDEX "PowerStateEvent_nodeId_observedAt_idx" ON "PowerStateEvent"("nodeId", "observedAt");
