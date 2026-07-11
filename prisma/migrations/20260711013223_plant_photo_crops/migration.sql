-- CreateTable
CREATE TABLE "PlantPhotoCrop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plantId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "cropX" REAL NOT NULL,
    "cropY" REAL NOT NULL,
    "cropWidth" REAL NOT NULL,
    "cropHeight" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlantPhotoCrop_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlantPhotoCrop_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlantPhotoCrop_plantId_idx" ON "PlantPhotoCrop"("plantId");

-- CreateIndex
CREATE INDEX "PlantPhotoCrop_photoId_idx" ON "PlantPhotoCrop"("photoId");

-- CreateIndex
CREATE UNIQUE INDEX "PlantPhotoCrop_plantId_photoId_key" ON "PlantPhotoCrop"("plantId", "photoId");
