-- CreateTable
CREATE TABLE "CaptureSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cameraDevice" TEXT NOT NULL,
    "cameraName" TEXT,
    "cameraStableId" TEXT,
    "cameraProfileId" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "flipHorizontal" BOOLEAN NOT NULL DEFAULT false,
    "flipVertical" BOOLEAN NOT NULL DEFAULT false,
    "captureDirectory" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "photoIntervalMinutes" INTEGER NOT NULL,
    "captureStartAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "captureWindowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "captureWindowStartMinutes" INTEGER,
    "captureWindowEndMinutes" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CaptureSource_cameraProfileId_fkey" FOREIGN KEY ("cameraProfileId") REFERENCES "CameraProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceCapture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "captureSourceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "scheduledFor" DATETIME,
    "originalPath" TEXT NOT NULL,
    "originalWidth" INTEGER NOT NULL,
    "originalHeight" INTEGER NOT NULL,
    "workingWidth" INTEGER NOT NULL,
    "workingHeight" INTEGER NOT NULL,
    "pixelFormat" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceCapture_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectViewport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "captureSourceId" TEXT NOT NULL,
    "cropX" REAL NOT NULL,
    "cropY" REAL NOT NULL,
    "cropWidth" REAL NOT NULL,
    "cropHeight" REAL NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceCaptureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectViewport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectViewport_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectViewport_sourceCaptureId_fkey" FOREIGN KEY ("sourceCaptureId") REFERENCES "SourceCapture" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "notes" TEXT,
    "sourceCaptureId" TEXT,
    "viewportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Photo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_sourceCaptureId_fkey" FOREIGN KEY ("sourceCaptureId") REFERENCES "SourceCapture" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Photo_viewportId_fkey" FOREIGN KEY ("viewportId") REFERENCES "ProjectViewport" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Photo" ("createdAt", "filename", "id", "notes", "path", "projectId", "timestamp", "updatedAt") SELECT "createdAt", "filename", "id", "notes", "path", "projectId", "timestamp", "updatedAt" FROM "Photo";
DROP TABLE "Photo";
ALTER TABLE "new_Photo" RENAME TO "Photo";
CREATE INDEX "Photo_projectId_timestamp_idx" ON "Photo"("projectId", "timestamp");
CREATE INDEX "Photo_sourceCaptureId_idx" ON "Photo"("sourceCaptureId");
CREATE INDEX "Photo_viewportId_idx" ON "Photo"("viewportId");
CREATE UNIQUE INDEX "Photo_projectId_path_key" ON "Photo"("projectId", "path");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CaptureSource_cameraDevice_idx" ON "CaptureSource"("cameraDevice");

-- CreateIndex
CREATE INDEX "SourceCapture_captureSourceId_timestamp_idx" ON "SourceCapture"("captureSourceId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCapture_captureSourceId_scheduledFor_key" ON "SourceCapture"("captureSourceId", "scheduledFor");

-- CreateIndex
CREATE INDEX "ProjectViewport_projectId_effectiveFrom_idx" ON "ProjectViewport"("projectId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ProjectViewport_captureSourceId_effectiveFrom_idx" ON "ProjectViewport"("captureSourceId", "effectiveFrom");
