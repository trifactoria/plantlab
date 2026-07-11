ALTER TABLE "Plant" ADD COLUMN "visualAspectRatio" TEXT;

ALTER TABLE "PlantPhotoCrop" ADD COLUMN "sourceCropId" TEXT;
ALTER TABLE "PlantPhotoCrop" ADD COLUMN "createdMethod" TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX "PlantPhotoCrop_sourceCropId_idx" ON "PlantPhotoCrop"("sourceCropId");
