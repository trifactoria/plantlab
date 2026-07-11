CREATE TABLE "ProjectMilestone" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ProjectMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectMilestone_projectId_key_key" ON "ProjectMilestone"("projectId", "key");
CREATE INDEX "ProjectMilestone_projectId_sortOrder_idx" ON "ProjectMilestone"("projectId", "sortOrder");

ALTER TABLE "PlantEvent" ADD COLUMN "milestoneId" TEXT;
CREATE INDEX "PlantEvent_milestoneId_idx" ON "PlantEvent"("milestoneId");

CREATE TABLE "PlantHarvestResult" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "plantId" TEXT NOT NULL,
  "harvestedAt" DATETIME NOT NULL,
  "rootWeightGrams" REAL,
  "rootDiameterMm" REAL,
  "rootLengthMm" REAL,
  "split" BOOLEAN NOT NULL DEFAULT false,
  "bolted" BOOLEAN NOT NULL DEFAULT false,
  "damaged" BOOLEAN NOT NULL DEFAULT false,
  "acceptable" BOOLEAN NOT NULL DEFAULT true,
  "flavorScore" INTEGER,
  "selectedForSeed" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PlantHarvestResult_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PlantHarvestResult_plantId_key" ON "PlantHarvestResult"("plantId");
