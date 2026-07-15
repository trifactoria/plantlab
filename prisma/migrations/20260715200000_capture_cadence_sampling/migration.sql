-- Capture cadence, illumination policy, source occurrence diagnostics,
-- and project sampling. Additive only: existing CaptureSource schedules are
-- preserved. Existing ProjectViewport rows inherit project-owned sampling
-- interval/anchor values so current fan-out behavior remains compatible.

ALTER TABLE "CaptureSource" ADD COLUMN "illuminationOutletId" TEXT;
ALTER TABLE "CaptureSource" ADD COLUMN "illuminationPolicy" TEXT NOT NULL DEFAULT 'unrestricted';

ALTER TABLE "ProjectViewport" ADD COLUMN "samplingEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProjectViewport" ADD COLUMN "samplingIntervalMinutes" INTEGER;
ALTER TABLE "ProjectViewport" ADD COLUMN "samplingAnchorAt" DATETIME;
ALTER TABLE "ProjectViewport" ADD COLUMN "lastSampledSlotAt" DATETIME;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "manualProjectId" TEXT;

UPDATE "ProjectViewport"
SET
  "samplingIntervalMinutes" = (
    SELECT "Project"."photoIntervalMinutes"
    FROM "Project"
    WHERE "Project"."id" = "ProjectViewport"."projectId"
  ),
  "samplingAnchorAt" = "effectiveFrom"
WHERE "samplingIntervalMinutes" IS NULL;

CREATE TABLE "CaptureSourceOccurrence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "captureSourceId" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "decisionAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "agentJobId" TEXT,
    "sourceCaptureId" TEXT,
    "requestedWidth" INTEGER,
    "requestedHeight" INTEGER,
    "requestedInputFormat" TEXT,
    "requestedFrameRate" TEXT,
    "effectiveWidth" INTEGER,
    "effectiveHeight" INTEGER,
    "effectiveInputFormat" TEXT,
    "effectiveFrameRate" TEXT,
    "capturedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaptureSourceOccurrence_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CaptureSourceOccurrence_agentJobId_fkey" FOREIGN KEY ("agentJobId") REFERENCES "AgentCaptureJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CaptureSourceOccurrence_sourceCaptureId_fkey" FOREIGN KEY ("sourceCaptureId") REFERENCES "SourceCapture" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ProjectSourceSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "viewportId" TEXT NOT NULL,
    "captureSourceId" TEXT NOT NULL,
    "sampleSlotAt" DATETIME NOT NULL,
    "sourceCaptureId" TEXT,
    "photoId" TEXT,
    "status" TEXT NOT NULL,
    "missingReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectSourceSample_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectSourceSample_viewportId_fkey" FOREIGN KEY ("viewportId") REFERENCES "ProjectViewport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectSourceSample_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectSourceSample_sourceCaptureId_fkey" FOREIGN KEY ("sourceCaptureId") REFERENCES "SourceCapture" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProjectSourceSample_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CaptureSource_illuminationOutletId_idx" ON "CaptureSource"("illuminationOutletId");
CREATE UNIQUE INDEX "CaptureSourceOccurrence_captureSourceId_scheduledFor_key" ON "CaptureSourceOccurrence"("captureSourceId", "scheduledFor");
CREATE INDEX "CaptureSourceOccurrence_captureSourceId_status_scheduledFor_idx" ON "CaptureSourceOccurrence"("captureSourceId", "status", "scheduledFor");
CREATE INDEX "CaptureSourceOccurrence_agentJobId_idx" ON "CaptureSourceOccurrence"("agentJobId");
CREATE INDEX "CaptureSourceOccurrence_sourceCaptureId_idx" ON "CaptureSourceOccurrence"("sourceCaptureId");
CREATE INDEX "ProjectViewport_captureSourceId_samplingEnabled_idx" ON "ProjectViewport"("captureSourceId", "samplingEnabled");
CREATE UNIQUE INDEX "ProjectSourceSample_projectId_viewportId_sampleSlotAt_key" ON "ProjectSourceSample"("projectId", "viewportId", "sampleSlotAt");
CREATE INDEX "ProjectSourceSample_captureSourceId_sampleSlotAt_idx" ON "ProjectSourceSample"("captureSourceId", "sampleSlotAt");
CREATE INDEX "ProjectSourceSample_sourceCaptureId_idx" ON "ProjectSourceSample"("sourceCaptureId");
CREATE INDEX "ProjectSourceSample_photoId_idx" ON "ProjectSourceSample"("photoId");
CREATE INDEX "AgentCaptureJob_manualProjectId_idx" ON "AgentCaptureJob"("manualProjectId");
