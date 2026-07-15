/**
 * Client-safe copy of the project sensor binding role vocabulary. Kept
 * separate from src/lib/operations/projectSensors.ts (which throws if
 * evaluated in a browser) so client components building a role picker don't
 * have to pull in server-only Prisma operational code just for this list.
 */
export const PROJECT_SENSOR_ROLES = [
  "ambient",
  "outside-reference",
  "top-shelf",
  "middle-shelf",
  "bottom-shelf",
  "root-zone",
  "custom",
] as const;

export type ProjectSensorRole = (typeof PROJECT_SENSOR_ROLES)[number];
