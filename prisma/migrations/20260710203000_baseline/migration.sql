-- Baseline for the existing PlantLab v0.1 SQLite schema.
-- This migration is marked as applied for existing development databases.
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gridWidth" INTEGER NOT NULL,
    "gridHeight" INTEGER NOT NULL,
    "photoIntervalMinutes" INTEGER NOT NULL,
    "localPhotoDirectory" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Plant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" TEXT,
    "notes" TEXT,
    "gridX" INTEGER NOT NULL,
    "gridY" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Plant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Photo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PlantEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "plantId" TEXT NOT NULL,
    "photoId" TEXT,
    "type" TEXT NOT NULL,
    "notes" TEXT,
    "timestamp" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlantEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantEvent_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantEvent_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Plant_projectId_gridX_gridY_key" ON "Plant"("projectId", "gridX", "gridY");
CREATE INDEX "Plant_projectId_idx" ON "Plant"("projectId");
CREATE UNIQUE INDEX "Photo_projectId_path_key" ON "Photo"("projectId", "path");
CREATE INDEX "Photo_projectId_timestamp_idx" ON "Photo"("projectId", "timestamp");
CREATE INDEX "PlantEvent_projectId_timestamp_idx" ON "PlantEvent"("projectId", "timestamp");
CREATE INDEX "PlantEvent_plantId_timestamp_idx" ON "PlantEvent"("plantId", "timestamp");
CREATE INDEX "PlantEvent_photoId_idx" ON "PlantEvent"("photoId");
