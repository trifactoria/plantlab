-- AlterTable
ALTER TABLE "PowerSchedule" ADD COLUMN "lastCommandId" TEXT;

-- CreateIndex
CREATE INDEX "PowerSchedule_lastCommandId_idx" ON "PowerSchedule"("lastCommandId");
