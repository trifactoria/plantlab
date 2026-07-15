-- Additive ownership split for user-owned display names versus
-- hardware/agent-reported names. Legacy name columns remain as compatibility
-- mirrors while routes migrate to displayName -> reportedName fallback.

ALTER TABLE "NodeCamera" ADD COLUMN "displayName" TEXT;
ALTER TABLE "NodeCamera" ADD COLUMN "reportedName" TEXT;

UPDATE "NodeCamera"
SET "displayName" = "name"
WHERE "displayName" IS NULL AND "name" IS NOT NULL;

UPDATE "NodeCamera"
SET "reportedName" = (
  SELECT "NodeCameraEndpoint"."name"
  FROM "NodeCameraEndpoint"
  WHERE "NodeCameraEndpoint"."nodeCameraId" = "NodeCamera"."id"
    AND "NodeCameraEndpoint"."name" IS NOT NULL
  ORDER BY "NodeCameraEndpoint"."available" DESC, "NodeCameraEndpoint"."observedAt" DESC
  LIMIT 1
)
WHERE "reportedName" IS NULL;

UPDATE "NodeCamera"
SET "reportedName" = "name"
WHERE "reportedName" IS NULL AND "name" IS NOT NULL;

ALTER TABLE "NodeSensor" ADD COLUMN "displayName" TEXT;
ALTER TABLE "NodeSensor" ADD COLUMN "reportedName" TEXT;

UPDATE "NodeSensor"
SET "displayName" = "name"
WHERE "displayName" IS NULL AND "name" IS NOT NULL;

UPDATE "NodeSensor"
SET "reportedName" = "name"
WHERE "reportedName" IS NULL AND "name" IS NOT NULL;
