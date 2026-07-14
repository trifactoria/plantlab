import { NextResponse } from "next/server";
import { getSensorDetail } from "@/lib/operations/environmentProtocol";
import { getActiveOrLatestSensorTest, listRecentSensorTests, serializeSensorTestCommand } from "@/lib/operations/sensorTestProtocol";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ nodeName: string; sensorKey: string }> }) {
  const { nodeName, sensorKey } = await context.params;
  const detail = await getSensorDetail(prisma, nodeName, sensorKey);
  if (!detail.ok) {
    return NextResponse.json({ error: detail.error }, { status: detail.status });
  }

  const [activeOrLatestTest, recentTests] = await Promise.all([
    getActiveOrLatestSensorTest(prisma, detail.node.id, sensorKey),
    listRecentSensorTests(prisma, detail.node.id, sensorKey),
  ]);

  return NextResponse.json({
    node: detail.node,
    sensor: detail.sensor,
    events: detail.events,
    activeTest: activeOrLatestTest && ["pending", "claimed", "running"].includes(activeOrLatestTest.status) ? serializeSensorTestCommand(activeOrLatestTest) : null,
    recentTests: recentTests.map(serializeSensorTestCommand),
  });
}
