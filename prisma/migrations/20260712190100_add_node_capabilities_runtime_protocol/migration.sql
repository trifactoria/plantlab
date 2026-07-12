-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlantLabNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enrolled',
    "operatingSystem" TEXT,
    "architecture" TEXT,
    "softwareVersion" TEXT,
    "coordinatorUrl" TEXT,
    "lastHeartbeatAt" DATETIME,
    "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "runtime" TEXT,
    "protocolVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PlantLabNode" ("architecture", "coordinatorUrl", "createdAt", "hostname", "id", "lastHeartbeatAt", "name", "operatingSystem", "role", "softwareVersion", "status", "updatedAt") SELECT "architecture", "coordinatorUrl", "createdAt", "hostname", "id", "lastHeartbeatAt", "name", "operatingSystem", "role", "softwareVersion", "status", "updatedAt" FROM "PlantLabNode";
DROP TABLE "PlantLabNode";
ALTER TABLE "new_PlantLabNode" RENAME TO "PlantLabNode";
CREATE UNIQUE INDEX "PlantLabNode_name_key" ON "PlantLabNode"("name");
CREATE INDEX "PlantLabNode_role_idx" ON "PlantLabNode"("role");
CREATE INDEX "PlantLabNode_lastHeartbeatAt_idx" ON "PlantLabNode"("lastHeartbeatAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
