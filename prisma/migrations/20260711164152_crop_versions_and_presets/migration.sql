-- CreateTable
CREATE TABLE "ProjectCropPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "aspectRatioMode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectCropPreset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlantCropVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cropX" REAL NOT NULL,
    "cropY" REAL NOT NULL,
    "cropWidth" REAL NOT NULL,
    "cropHeight" REAL NOT NULL,
    "aspectRatioMode" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "sourcePhotoId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlantCropVersion_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantCropVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantCropVersion_sourcePhotoId_fkey" FOREIGN KEY ("sourcePhotoId") REFERENCES "Photo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Plant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" TEXT,
    "notes" TEXT,
    "gridX" INTEGER NOT NULL,
    "gridY" INTEGER NOT NULL,
    "visualAspectRatio" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startLabel" TEXT NOT NULL DEFAULT 'Added to project',
    "automaticCropAssignmentEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Plant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Plant" ("createdAt", "gridX", "gridY", "id", "name", "notes", "projectId", "startLabel", "startedAt", "tags", "updatedAt", "visualAspectRatio") SELECT "createdAt", "gridX", "gridY", "id", "name", "notes", "projectId", "startLabel", "startedAt", "tags", "updatedAt", "visualAspectRatio" FROM "Plant";
DROP TABLE "Plant";
ALTER TABLE "new_Plant" RENAME TO "Plant";
CREATE INDEX "Plant_projectId_idx" ON "Plant"("projectId");
CREATE UNIQUE INDEX "Plant_projectId_gridX_gridY_key" ON "Plant"("projectId", "gridX", "gridY");
CREATE TABLE "new_PlantPhotoCrop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plantId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "cropX" REAL NOT NULL,
    "cropY" REAL NOT NULL,
    "cropWidth" REAL NOT NULL,
    "cropHeight" REAL NOT NULL,
    "sourceCropId" TEXT,
    "createdMethod" TEXT NOT NULL DEFAULT 'manual',
    "cropVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlantPhotoCrop_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantPhotoCrop_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantPhotoCrop_cropVersionId_fkey" FOREIGN KEY ("cropVersionId") REFERENCES "PlantCropVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PlantPhotoCrop" ("createdAt", "createdMethod", "cropHeight", "cropWidth", "cropX", "cropY", "id", "photoId", "plantId", "sourceCropId", "updatedAt") SELECT "createdAt", "createdMethod", "cropHeight", "cropWidth", "cropX", "cropY", "id", "photoId", "plantId", "sourceCropId", "updatedAt" FROM "PlantPhotoCrop";
DROP TABLE "PlantPhotoCrop";
ALTER TABLE "new_PlantPhotoCrop" RENAME TO "PlantPhotoCrop";
CREATE INDEX "PlantPhotoCrop_plantId_idx" ON "PlantPhotoCrop"("plantId");
CREATE INDEX "PlantPhotoCrop_cropVersionId_idx" ON "PlantPhotoCrop"("cropVersionId");
CREATE INDEX "PlantPhotoCrop_photoId_idx" ON "PlantPhotoCrop"("photoId");
CREATE INDEX "PlantPhotoCrop_sourceCropId_idx" ON "PlantPhotoCrop"("sourceCropId");
CREATE UNIQUE INDEX "PlantPhotoCrop_plantId_photoId_key" ON "PlantPhotoCrop"("plantId", "photoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCropPreset_projectId_key" ON "ProjectCropPreset"("projectId");

-- CreateIndex
CREATE INDEX "PlantCropVersion_plantId_effectiveFrom_idx" ON "PlantCropVersion"("plantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PlantCropVersion_projectId_idx" ON "PlantCropVersion"("projectId");
