-- AlterTable
ALTER TABLE "PlantLabNode" ADD COLUMN "powerStateRefreshRequestedAt" DATETIME;

-- AlterTable
ALTER TABLE "SensorDiagnostic" ADD COLUMN "attemptNumber" INTEGER;
ALTER TABLE "SensorDiagnostic" ADD COLUMN "driver" TEXT;
ALTER TABLE "SensorDiagnostic" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "SensorDiagnostic" ADD COLUMN "gpio" INTEGER;

-- CreateTable
CREATE TABLE "SensorTestCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "sensorKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptsRequested" INTEGER NOT NULL,
    "intervalSeconds" REAL NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "requestedBy" TEXT,
    "attemptsCompleted" INTEGER,
    "acceptedCount" INTEGER,
    "failedCount" INTEGER,
    "finalPass" BOOLEAN,
    "effectiveDriver" TEXT,
    "configuredGpio" INTEGER,
    "attemptsJson" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SensorTestCommand_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SensorTestCommand_nodeId_sensorKey_status_idx" ON "SensorTestCommand"("nodeId", "sensorKey", "status");

-- CreateIndex
CREATE INDEX "SensorTestCommand_nodeId_status_availableAt_idx" ON "SensorTestCommand"("nodeId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "SensorTestCommand_expiresAt_idx" ON "SensorTestCommand"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SensorTestCommand_nodeId_idempotencyKey_key" ON "SensorTestCommand"("nodeId", "idempotencyKey");
