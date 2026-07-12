import type { NodeRole } from "./config";
import type { PlantLabUnitName } from "./systemdUnits";

export const PLANTLAB_SERVICES = ["web", "camera", "agent"] as const;
export type PlantLabServiceName = (typeof PLANTLAB_SERVICES)[number];

export const SERVICE_UNITS: Record<PlantLabServiceName, PlantLabUnitName> = {
  web: "plantlab-web.service",
  camera: "plantlab-camera.service",
  agent: "plantlab-agent.service",
};

export function isPlantLabServiceName(value: string): value is PlantLabServiceName {
  return (PLANTLAB_SERVICES as readonly string[]).includes(value);
}

/**
 * Services a valid, known role expects to be running. Returns an EMPTY
 * array for an unknown/null/unconfigured role - it must never silently
 * fall back to any particular role's service set (see DEPLOYMENT.md
 * "Role-aware service start must use intended state safely" - a node with
 * no valid role configuration must never have services started on its
 * behalf just because a caller happened to omit or misspell a role).
 * Callers that need a concrete answer for an unknown role must handle that
 * explicitly - see requireExpectedServicesForRole() for mutating commands.
 */
export function expectedServicesForRole(role: string | null | undefined): PlantLabServiceName[] {
  if (role === "camera-node") {
    return ["agent"];
  }
  if (role === "coordinator") {
    return ["web"];
  }
  if (role === "standalone" || role === "microscope-node" || role === "mobile-uploader") {
    return ["web", "camera"];
  }
  return [];
}

/**
 * For commands that CHANGE service state (start/stop/restart, or role
 * convergence) - throws instead of returning an empty/default set when the
 * role is unknown, so a caller can never accidentally start or stop
 * services "because expectedServicesForRole() returned something plausible
 * by default." Read-only commands (service status, doctor) should keep
 * using expectedServicesForRole()/inappropriateServicesForRole() directly,
 * or pass `all: true` to serviceUnitsForSelection() to explicitly show
 * every installed unit regardless of role.
 */
export function requireExpectedServicesForRole(role: string | null | undefined): PlantLabServiceName[] {
  const expected = expectedServicesForRole(role);
  if (expected.length === 0) {
    throw new Error(
      role ? `Unknown role "${role}" - cannot determine which services should run.` : "No role is configured for this node.",
    );
  }
  return expected;
}

export function inappropriateServicesForRole(role: string | null | undefined): PlantLabServiceName[] {
  const expected = new Set(expectedServicesForRole(role));
  return PLANTLAB_SERVICES.filter((service) => !expected.has(service));
}

export function serviceUnitsForSelection(input: {
  role?: NodeRole | string | null;
  service?: string;
  all?: boolean;
}): string[] {
  if (input.all) {
    return PLANTLAB_SERVICES.map((service) => SERVICE_UNITS[service]);
  }
  if (input.service) {
    if (!isPlantLabServiceName(input.service)) {
      throw new Error(`Unknown service "${input.service}". Valid values: ${PLANTLAB_SERVICES.join(", ")}`);
    }
    return [SERVICE_UNITS[input.service]];
  }
  return requireExpectedServicesForRole(input.role).map((service) => SERVICE_UNITS[service]);
}
