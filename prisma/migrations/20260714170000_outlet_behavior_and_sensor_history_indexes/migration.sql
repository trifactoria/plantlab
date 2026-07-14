-- Explicit outlet behavior replaces key/name/safety-class assumptions.
ALTER TABLE "NodeOutlet" ADD COLUMN "behavior" TEXT NOT NULL DEFAULT 'normal';

CREATE INDEX "NodeOutlet_behavior_idx" ON "NodeOutlet"("behavior");
CREATE INDEX "SensorReading_nodeId_sensorId_capturedAt_idx" ON "SensorReading"("nodeId", "sensorId", "capturedAt");
