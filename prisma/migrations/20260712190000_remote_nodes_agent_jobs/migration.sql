-- CreateTable
CREATE TABLE "PlantLabNode" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NodeCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "NodeCredential_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NodeCamera" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "devicePath" TEXT NOT NULL,
    "name" TEXT,
    "formatsJson" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captureSourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeCamera_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeCamera_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NodeCameraAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeCameraId" TEXT NOT NULL,
    "captureSourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "inputFormat" TEXT NOT NULL DEFAULT 'mjpeg',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeCameraAssignment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeCameraAssignment_nodeCameraId_fkey" FOREIGN KEY ("nodeCameraId") REFERENCES "NodeCamera" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeCameraAssignment_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentCaptureJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "captureSourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "captureId" TEXT,
    "sourceCaptureId" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentCaptureJob_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "PlantLabNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentCaptureJob_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "NodeCameraAssignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentCaptureJob_captureSourceId_fkey" FOREIGN KEY ("captureSourceId") REFERENCES "CaptureSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlantLabNode_name_key" ON "PlantLabNode"("name");

-- CreateIndex
CREATE INDEX "PlantLabNode_role_idx" ON "PlantLabNode"("role");

-- CreateIndex
CREATE INDEX "PlantLabNode_lastHeartbeatAt_idx" ON "PlantLabNode"("lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeCredential_credentialHash_key" ON "NodeCredential"("credentialHash");

-- CreateIndex
CREATE INDEX "NodeCredential_nodeId_idx" ON "NodeCredential"("nodeId");

-- CreateIndex
CREATE INDEX "NodeCredential_revokedAt_idx" ON "NodeCredential"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeCamera_nodeId_stableId_key" ON "NodeCamera"("nodeId", "stableId");

-- CreateIndex
CREATE INDEX "NodeCamera_nodeId_idx" ON "NodeCamera"("nodeId");

-- CreateIndex
CREATE INDEX "NodeCamera_captureSourceId_idx" ON "NodeCamera"("captureSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeCameraAssignment_nodeId_nodeCameraId_captureSourceId_key" ON "NodeCameraAssignment"("nodeId", "nodeCameraId", "captureSourceId");

-- CreateIndex
CREATE INDEX "NodeCameraAssignment_nodeId_idx" ON "NodeCameraAssignment"("nodeId");

-- CreateIndex
CREATE INDEX "NodeCameraAssignment_captureSourceId_idx" ON "NodeCameraAssignment"("captureSourceId");

-- CreateIndex
CREATE INDEX "NodeCameraAssignment_active_idx" ON "NodeCameraAssignment"("active");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCaptureJob_captureId_key" ON "AgentCaptureJob"("captureId");

-- CreateIndex
CREATE INDEX "AgentCaptureJob_nodeId_status_requestedAt_idx" ON "AgentCaptureJob"("nodeId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "AgentCaptureJob_assignmentId_idx" ON "AgentCaptureJob"("assignmentId");

-- CreateIndex
CREATE INDEX "AgentCaptureJob_captureSourceId_idx" ON "AgentCaptureJob"("captureSourceId");
