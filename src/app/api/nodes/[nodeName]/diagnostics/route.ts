import { NextResponse } from "next/server";
import { createSensorTestCommand, serializeSensorTestCommand } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

const DIAGNOSTIC_SWEEP_ATTEMPTS = 3;
const DIAGNOSTIC_SWEEP_INTERVAL_SECONDS = 2;

/**
 * "Run node diagnostics" - the browser-triggered equivalent of
 * `plantlab-edge doctor --all-sensors`: queues a bounded sensor test for
 * every currently enabled sensor on this node. One sensor already having
 * an active test (409) does not stop the sweep for the others - matches
 * "one sensor failure must not stop tests for the others."
 */
export async function POST(_request: Request, context: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await context.params;
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName }, include: { sensors: { where: { enabled: true } } } });
  if (!node) {
    return NextResponse.json({ error: "Node not found." }, { status: 404 });
  }

  const results = await Promise.all(
    node.sensors.map(async (sensor) => {
      const result = await createSensorTestCommand(prisma, nodeName, {
        sensorKey: sensor.key,
        attempts: DIAGNOSTIC_SWEEP_ATTEMPTS,
        intervalSeconds: DIAGNOSTIC_SWEEP_INTERVAL_SECONDS,
        requestedBy: "browser:node-diagnostics",
      });
      return {
        sensorKey: sensor.key,
        ok: result.ok,
        command: result.ok ? serializeSensorTestCommand(result.command) : result.command ? serializeSensorTestCommand(result.command) : null,
        error: result.ok ? null : result.error,
      };
    }),
  );

  return NextResponse.json({ results });
}
