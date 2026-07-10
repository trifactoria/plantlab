-- CreateTable
CREATE TABLE "CaptureRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "photoId" TEXT,
    "errorMessage" TEXT,
    "cameraDevice" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaptureRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaptureRun_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "lastHeartbeat" DATETIME NOT NULL,
    "pid" INTEGER,
    "hostname" TEXT,
    "version" TEXT,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gridWidth" INTEGER NOT NULL,
    "gridHeight" INTEGER NOT NULL,
    "photoIntervalMinutes" INTEGER NOT NULL,
    "captureStartAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captureEnabled" BOOLEAN NOT NULL DEFAULT false,
    "plantedAt" DATETIME,
    "localPhotoDirectory" TEXT NOT NULL,
    "cameraDevice" TEXT,
    "cameraName" TEXT,
    "cameraProfileId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_cameraProfileId_fkey" FOREIGN KEY ("cameraProfileId") REFERENCES "CameraProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("cameraDevice", "cameraName", "cameraProfileId", "captureStartAt", "createdAt", "description", "gridHeight", "gridWidth", "id", "localPhotoDirectory", "name", "photoIntervalMinutes", "plantedAt", "updatedAt") SELECT "cameraDevice", "cameraName", "cameraProfileId", "captureStartAt", "createdAt", "description", "gridHeight", "gridWidth", "id", "localPhotoDirectory", "name", "photoIntervalMinutes", "plantedAt", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CaptureRun_projectId_scheduledFor_idx" ON "CaptureRun"("projectId", "scheduledFor");

-- CreateIndex
CREATE INDEX "CaptureRun_status_idx" ON "CaptureRun"("status");
