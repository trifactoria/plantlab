-- Additive project capture/sensor foundations for coordinator-managed
-- camera sources and environmental history bindings.

ALTER TABLE "AgentCaptureJob" ADD COLUMN "scheduledFor" DATETIME;

CREATE TABLE "ProjectSensorBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "sensorId" TEXT NOT NULL,
    "label" TEXT,
    "role" TEXT NOT NULL DEFAULT 'ambient',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectSensorBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectSensorBinding_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProjectSensorBinding_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "NodeSensor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "AgentCaptureJob_captureSourceId_scheduledFor_idx" ON "AgentCaptureJob"("captureSourceId", "scheduledFor");

CREATE INDEX "ProjectSensorBinding_projectId_enabled_idx" ON "ProjectSensorBinding"("projectId", "enabled");
CREATE INDEX "ProjectSensorBinding_sensorId_idx" ON "ProjectSensorBinding"("sensorId");
CREATE INDEX "ProjectSensorBinding_nodeId_idx" ON "ProjectSensorBinding"("nodeId");
CREATE INDEX "ProjectSensorBinding_projectId_sensorId_enabled_idx" ON "ProjectSensorBinding"("projectId", "sensorId", "enabled");
