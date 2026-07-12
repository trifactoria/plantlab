-- AlterTable
ALTER TABLE "SourceCapture" ADD COLUMN "byteSize" INTEGER;
ALTER TABLE "SourceCapture" ADD COLUMN "captureId" TEXT;
ALTER TABLE "SourceCapture" ADD COLUMN "ingestSource" TEXT;
ALTER TABLE "SourceCapture" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "SourceCapture" ADD COLUMN "originalFilename" TEXT;
ALTER TABLE "SourceCapture" ADD COLUMN "sha256" TEXT;
ALTER TABLE "SourceCapture" ADD COLUMN "storageKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SourceCapture_captureId_key" ON "SourceCapture"("captureId");

