-- CreateTable
CREATE TABLE "PowerSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "outletKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "daysOfWeek" TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    "timeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunDateKey" TEXT,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PowerSchedule_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PowerSchedule_nodeId_outletKey_idx" ON "PowerSchedule"("nodeId", "outletKey");

-- CreateIndex
CREATE INDEX "PowerSchedule_nodeId_enabled_idx" ON "PowerSchedule"("nodeId", "enabled");
