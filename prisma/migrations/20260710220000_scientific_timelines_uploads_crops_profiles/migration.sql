PRAGMA foreign_keys=OFF;

CREATE TABLE "CameraProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cameraDevice" TEXT NOT NULL,
    "cameraName" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "inputFormat" TEXT NOT NULL,
    "controlsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "CameraProfile_cameraDevice_idx" ON "CameraProfile"("cameraDevice");

CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gridWidth" INTEGER NOT NULL,
    "gridHeight" INTEGER NOT NULL,
    "photoIntervalMinutes" INTEGER NOT NULL,
    "captureStartAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plantedAt" DATETIME,
    "localPhotoDirectory" TEXT NOT NULL,
    "cameraDevice" TEXT,
    "cameraName" TEXT,
    "cameraProfileId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_cameraProfileId_fkey" FOREIGN KEY ("cameraProfileId") REFERENCES "CameraProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Project" (
    "id",
    "name",
    "description",
    "gridWidth",
    "gridHeight",
    "photoIntervalMinutes",
    "captureStartAt",
    "localPhotoDirectory",
    "cameraDevice",
    "cameraName",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "name",
    "description",
    "gridWidth",
    "gridHeight",
    "photoIntervalMinutes",
    "captureStartAt",
    "localPhotoDirectory",
    "cameraDevice",
    "cameraName",
    "createdAt",
    "updatedAt"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";

CREATE TABLE "new_Plant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" TEXT,
    "notes" TEXT,
    "gridX" INTEGER NOT NULL,
    "gridY" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startLabel" TEXT NOT NULL DEFAULT 'Added to project',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Plant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Plant" (
    "id",
    "projectId",
    "name",
    "tags",
    "notes",
    "gridX",
    "gridY",
    "startedAt",
    "startLabel",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "projectId",
    "name",
    "tags",
    "notes",
    "gridX",
    "gridY",
    "createdAt",
    'Added to project',
    "createdAt",
    "updatedAt"
FROM "Plant";

DROP TABLE "Plant";
ALTER TABLE "new_Plant" RENAME TO "Plant";

CREATE UNIQUE INDEX "Plant_projectId_gridX_gridY_key" ON "Plant"("projectId", "gridX", "gridY");
CREATE INDEX "Plant_projectId_idx" ON "Plant"("projectId");

ALTER TABLE "PlantEvent" ADD COLUMN "cropX" REAL;
ALTER TABLE "PlantEvent" ADD COLUMN "cropY" REAL;
ALTER TABLE "PlantEvent" ADD COLUMN "cropWidth" REAL;
ALTER TABLE "PlantEvent" ADD COLUMN "cropHeight" REAL;

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
