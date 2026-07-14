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
  // greenhouse-node shares plantlab-agent.service with camera-node (a
  // greenhouse-node with a Pi-Zero-class runtime never reaches this path at
  // all - it uses the separate lightweight edge agent instead, see
  // edge-agent/ and node.ts's attach flow). Only a full-power
  // greenhouse-node machine converges through here.
  if (role === "camera-node" || role === "greenhouse-node") {
    return ["agent"];
  }
  // "camera" (plantlab-camera.service) is misnamed for this role - a
  // coordinator has no local camera hardware to capture from. It's
  // included here because it's also the only process that ticks
  // PowerScheduler (src/lib/operations/powerSchedule.ts) and the capture
  // schedulers; a coordinator with persistent greenhouse power schedules
  // needs that loop running just as much as a standalone machine does.
  // Discovered 2026-07-14: role convergence previously stopped/disabled
  // this service on a coordinator as "inappropriate," which silently
  // stopped every power schedule from ever firing on a properly-converged
  // coordinator host - see the incident report in that day's commit.
  // With zero local Projects/CaptureSources configured (the normal case
  // for a pure coordinator), its capture-related ticks are simply no-ops.
  if (role === "coordinator") {
    return ["web", "camera"];
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
