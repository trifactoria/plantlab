-- Node-owned greenhouse/environmental telemetry. Sensors are not project-owned;
-- project/shelf/zone assignment is intentionally left to a later stage.

CREATE TABLE "NodeSensor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "gpio" INTEGER,
    "placement" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "lastAcceptedAt" DATETIME,
    "latestClassification" TEXT,
    "latestTemperatureC" REAL,
    "latestHumidityPct" REAL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveRejects" INTEGER NOT NULL DEFAULT 0,
    "lastDiagnosticCode" TEXT,
    "lastDiagnosticMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeSensor_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SensorReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sensorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "temperatureC" REAL NOT NULL,
    "humidityPct" REAL NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SensorReading_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "NodeSensor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SensorReading_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SensorDiagnostic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sensorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "classification" TEXT NOT NULL,
    "temperatureC" REAL,
    "humidityPct" REAL,
    "code" TEXT,
    "message" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SensorDiagnostic_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "NodeSensor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SensorDiagnostic_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "NodeSensor_nodeId_key_key" ON "NodeSensor"("nodeId", "key");
CREATE INDEX "NodeSensor_nodeId_idx" ON "NodeSensor"("nodeId");
CREATE INDEX "NodeSensor_lastSeenAt_idx" ON "NodeSensor"("lastSeenAt");
CREATE INDEX "NodeSensor_latestClassification_idx" ON "NodeSensor"("latestClassification");

CREATE INDEX "SensorReading_sensorId_capturedAt_idx" ON "SensorReading"("sensorId", "capturedAt");
CREATE INDEX "SensorReading_nodeId_capturedAt_idx" ON "SensorReading"("nodeId", "capturedAt");
CREATE UNIQUE INDEX "SensorReading_nodeId_eventId_key" ON "SensorReading"("nodeId", "eventId");

CREATE INDEX "SensorDiagnostic_sensorId_capturedAt_idx" ON "SensorDiagnostic"("sensorId", "capturedAt");
CREATE INDEX "SensorDiagnostic_nodeId_capturedAt_idx" ON "SensorDiagnostic"("nodeId", "capturedAt");
CREATE INDEX "SensorDiagnostic_classification_idx" ON "SensorDiagnostic"("classification");
CREATE UNIQUE INDEX "SensorDiagnostic_nodeId_eventId_key" ON "SensorDiagnostic"("nodeId", "eventId");
