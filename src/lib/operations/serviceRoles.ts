import type { NodeRole } from "./config";

export const PLANTLAB_SERVICES = ["web", "camera", "agent"] as const;
export type PlantLabServiceName = (typeof PLANTLAB_SERVICES)[number];

export const SERVICE_UNITS: Record<PlantLabServiceName, string> = {
  web: "plantlab-web.service",
  camera: "plantlab-camera.service",
  agent: "plantlab-agent.service",
};

export function isPlantLabServiceName(value: string): value is PlantLabServiceName {
  return (PLANTLAB_SERVICES as readonly string[]).includes(value);
}

export function expectedServicesForRole(role: string | null | undefined): PlantLabServiceName[] {
  if (role === "camera-node") {
    return ["agent"];
  }
  if (role === "coordinator") {
    return ["web"];
  }
  if (role === "standalone") {
    return ["web", "camera"];
  }
  return ["web", "camera"];
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
  return expectedServicesForRole(input.role).map((service) => SERVICE_UNITS[service]);
}
