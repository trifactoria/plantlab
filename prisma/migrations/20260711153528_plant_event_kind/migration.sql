-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlantEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "plantId" TEXT NOT NULL,
    "photoId" TEXT,
    "milestoneId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'observation',
    "type" TEXT NOT NULL,
    "notes" TEXT,
    "timestamp" DATETIME NOT NULL,
    "cropX" REAL,
    "cropY" REAL,
    "cropWidth" REAL,
    "cropHeight" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlantEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantEvent_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantEvent_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PlantEvent_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "ProjectMilestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PlantEvent" ("createdAt", "cropHeight", "cropWidth", "cropX", "cropY", "id", "milestoneId", "notes", "photoId", "plantId", "projectId", "timestamp", "type") SELECT "createdAt", "cropHeight", "cropWidth", "cropX", "cropY", "id", "milestoneId", "notes", "photoId", "plantId", "projectId", "timestamp", "type" FROM "PlantEvent";
DROP TABLE "PlantEvent";
ALTER TABLE "new_PlantEvent" RENAME TO "PlantEvent";
CREATE INDEX "PlantEvent_projectId_timestamp_idx" ON "PlantEvent"("projectId", "timestamp");
CREATE INDEX "PlantEvent_plantId_timestamp_idx" ON "PlantEvent"("plantId", "timestamp");
CREATE INDEX "PlantEvent_photoId_idx" ON "PlantEvent"("photoId");
CREATE INDEX "PlantEvent_milestoneId_idx" ON "PlantEvent"("milestoneId");

-- Enforces at most one origin ("Added to project") event per plant at the
-- database level, in addition to the application-level check performed
-- inside the creation/backfill transactions. SQLite supports partial
-- indexes, which Prisma's schema DSL cannot express directly.
CREATE UNIQUE INDEX "PlantEvent_plantId_origin_unique" ON "PlantEvent"("plantId") WHERE "kind" = 'origin';

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
