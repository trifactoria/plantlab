-- Node-owned greenhouse outlet inventory and bounded manual power commands.
CREATE TABLE "NodeOutlet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAlias" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "safetyClass" TEXT NOT NULL DEFAULT 'switch',
    "actualState" BOOLEAN,
    "stateObservedAt" DATETIME,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeOutlet_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PowerCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "outletId" TEXT,
    "outletKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "actualState" BOOLEAN,
    "stateObservedAt" DATETIME,
    "requestedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PowerCommand_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PowerCommand_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "NodeOutlet" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "NodeOutlet_nodeId_key_key" ON "NodeOutlet"("nodeId", "key");
CREATE INDEX "NodeOutlet_nodeId_idx" ON "NodeOutlet"("nodeId");
CREATE INDEX "NodeOutlet_available_idx" ON "NodeOutlet"("available");

CREATE UNIQUE INDEX "PowerCommand_nodeId_idempotencyKey_key" ON "PowerCommand"("nodeId", "idempotencyKey");
CREATE INDEX "PowerCommand_nodeId_status_availableAt_idx" ON "PowerCommand"("nodeId", "status", "availableAt");
CREATE INDEX "PowerCommand_nodeId_outletKey_status_idx" ON "PowerCommand"("nodeId", "outletKey", "status");
CREATE INDEX "PowerCommand_expiresAt_idx" ON "PowerCommand"("expiresAt");
