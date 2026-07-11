ALTER TABLE "Project" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE "Project" ADD COLUMN "captureWindowEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "captureWindowStartMinutes" INTEGER;
ALTER TABLE "Project" ADD COLUMN "captureWindowEndMinutes" INTEGER;
ALTER TABLE "Project" ADD COLUMN "isTestProject" BOOLEAN NOT NULL DEFAULT false;
