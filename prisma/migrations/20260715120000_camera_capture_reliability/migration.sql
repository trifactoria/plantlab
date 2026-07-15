-- Additive capture reliability controls and timing diagnostics.

ALTER TABLE "NodeCameraAssignment" ADD COLUMN "frameRate" TEXT;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "warmupFrames" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "warmupSeconds" REAL;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "captureAttempts" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "fallbackWidth" INTEGER;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "fallbackHeight" INTEGER;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "fallbackInputFormat" TEXT;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "fallbackFrameRate" TEXT;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "fallbackAttempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "NodeCameraAssignment" ADD COLUMN "serializeOnNode" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "AgentCaptureJob" ADD COLUMN "captureStartedAt" DATETIME;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "frameCapturedAt" DATETIME;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "uploadStartedAt" DATETIME;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "ingestedAt" DATETIME;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "effectiveWidth" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "effectiveHeight" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "effectiveInputFormat" TEXT;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "effectiveFrameRate" TEXT;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "warmupFrames" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "attemptCount" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "fallbackUsed" BOOLEAN;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "validationStatus" TEXT;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "validationErrorCode" TEXT;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "attemptsJson" TEXT;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "queueLatencyMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "scheduleToCaptureMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "captureDurationMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "uploadDurationMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "totalDurationMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "scheduledLatenessMs" INTEGER;
ALTER TABLE "AgentCaptureJob" ADD COLUMN "late" BOOLEAN NOT NULL DEFAULT false;
