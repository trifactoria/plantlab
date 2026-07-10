PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gridWidth" INTEGER NOT NULL,
    "gridHeight" INTEGER NOT NULL,
    "photoIntervalMinutes" INTEGER NOT NULL,
    "captureStartAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "localPhotoDirectory" TEXT NOT NULL,
    "cameraDevice" TEXT,
    "cameraName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
    COALESCE("createdAt", CURRENT_TIMESTAMP),
    "localPhotoDirectory",
    "createdAt",
    "updatedAt"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
