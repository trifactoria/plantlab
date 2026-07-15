"use client";

import { useEffect, useState } from "react";

export type AvailableProjectSensor = {
  id: string;
  key: string;
  name: string;
  type: string;
  placement: string | null;
  node: { id: string; name: string; role: string };
};

/**
 * Fetches GET /api/sensors/available (applied/configured-active sensors
 * across every node - see listAvailableProjectSensors in
 * src/lib/operations/projectSensors.ts). Shared by the project-creation
 * sensor checklist and the project settings sensor-linking panel so both
 * stay consistent with the same "currently configured" definition.
 */
export function useAvailableProjectSensors() {
  const [sensors, setSensors] = useState<AvailableProjectSensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setMessage(null);

    let response: Response;
    try {
      response = await fetch("/api/sensors/available", { cache: "no-store" });
    } catch {
      setLoading(false);
      setMessage("Could not reach the coordinator.");
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { sensors?: AvailableProjectSensor[]; error?: string };

    setLoading(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Could not load sensors.");
      return;
    }

    setSensors(payload.sensors ?? []);
    if ((payload.sensors ?? []).length === 0) {
      setMessage("No active sensors are configured yet.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return { sensors, loading, message, reload: load };
}
