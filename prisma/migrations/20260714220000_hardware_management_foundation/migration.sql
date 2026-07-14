-- Additive hardware-management foundation: camera endpoint history and
-- coordinator-owned sensor desired/applied configuration state.

ALTER TABLE "PlantLabNode" ADD COLUMN "desiredSensorConfigRevision" INTEGER;
ALTER TABLE "PlantLabNode" ADD COLUMN "appliedSensorConfigRevision" INTEGER;
ALTER TABLE "PlantLabNode" ADD COLUMN "appliedSensorConfigStatus" TEXT;
ALTER TABLE "PlantLabNode" ADD COLUMN "appliedSensorConfigError" TEXT;
ALTER TABLE "PlantLabNode" ADD COLUMN "sensorConfigUpdatedAt" DATETIME;

ALTER TABLE "NodeSensor" ADD COLUMN "configuredActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NodeSensor" ADD COLUMN "retiredAt" DATETIME;
ALTER TABLE "NodeSensor" ADD COLUMN "desiredConfigRevision" INTEGER;
ALTER TABLE "NodeSensor" ADD COLUMN "appliedConfigRevision" INTEGER;

ALTER TABLE "NodeCamera" ADD COLUMN "identityEvidenceJson" TEXT;
ALTER TABLE "NodeCamera" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NodeCamera" ADD COLUMN "retiredAt" DATETIME;

CREATE TABLE "NodeCameraEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeCameraId" TEXT,
    "stableId" TEXT NOT NULL,
    "devicePath" TEXT NOT NULL,
    "name" TEXT,
    "vendorId" TEXT,
    "productId" TEXT,
    "serial" TEXT,
    "physicalPath" TEXT,
    "usbPath" TEXT,
    "usbPort" TEXT,
    "alternateDevicesJson" TEXT,
    "formatsJson" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unavailableAt" DATETIME,
    "confidence" TEXT NOT NULL DEFAULT 'reported-stable-id',
    "evidenceJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeCameraEndpoint_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeCameraEndpoint_nodeCameraId_fkey" FOREIGN KEY ("nodeCameraId") REFERENCES "NodeCamera" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "NodeCameraRepairAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeCameraId" TEXT,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedBy" TEXT,
    "previousStateJson" TEXT,
    "nextStateJson" TEXT,
    "evidenceJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NodeCameraRepairAudit_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeCameraRepairAudit_nodeCameraId_fkey" FOREIGN KEY ("nodeCameraId") REFERENCES "NodeCamera" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "NodeSensorConfigRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'coordinator',
    "validationStatus" TEXT NOT NULL DEFAULT 'valid',
    "applyStatus" TEXT NOT NULL DEFAULT 'pending',
    "appliedAt" DATETIME,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "entriesJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeSensorConfigRevision_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "NodeCameraEndpoint_nodeId_stableId_devicePath_key" ON "NodeCameraEndpoint"("nodeId", "stableId", "devicePath");
CREATE INDEX "NodeCameraEndpoint_nodeId_available_idx" ON "NodeCameraEndpoint"("nodeId", "available");
CREATE INDEX "NodeCameraEndpoint_nodeCameraId_observedAt_idx" ON "NodeCameraEndpoint"("nodeCameraId", "observedAt");
CREATE INDEX "NodeCameraEndpoint_nodeId_stableId_idx" ON "NodeCameraEndpoint"("nodeId", "stableId");

CREATE INDEX "NodeCameraRepairAudit_nodeId_createdAt_idx" ON "NodeCameraRepairAudit"("nodeId", "createdAt");
CREATE INDEX "NodeCameraRepairAudit_nodeCameraId_idx" ON "NodeCameraRepairAudit"("nodeCameraId");
CREATE INDEX "NodeCameraRepairAudit_operation_status_idx" ON "NodeCameraRepairAudit"("operation", "status");

CREATE UNIQUE INDEX "NodeSensorConfigRevision_nodeId_revision_key" ON "NodeSensorConfigRevision"("nodeId", "revision");
CREATE INDEX "NodeSensorConfigRevision_nodeId_applyStatus_idx" ON "NodeSensorConfigRevision"("nodeId", "applyStatus");
CREATE INDEX "NodeSensorConfigRevision_requestedAt_idx" ON "NodeSensorConfigRevision"("requestedAt");

CREATE INDEX "PlantLabNode_desiredSensorConfigRevision_idx" ON "PlantLabNode"("desiredSensorConfigRevision");
CREATE INDEX "PlantLabNode_appliedSensorConfigRevision_idx" ON "PlantLabNode"("appliedSensorConfigRevision");
CREATE INDEX "NodeSensor_nodeId_configuredActive_idx" ON "NodeSensor"("nodeId", "configuredActive");
CREATE INDEX "NodeSensor_retiredAt_idx" ON "NodeSensor"("retiredAt");
CREATE INDEX "NodeCamera_nodeId_available_idx" ON "NodeCamera"("nodeId", "available");
CREATE INDEX "NodeCamera_retiredAt_idx" ON "NodeCamera"("retiredAt");
