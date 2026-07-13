import { describe, expect, it } from "vitest";
import { getCoordinatorDashboardData } from "../../src/lib/operations/coordinatorDashboard";
import { registerOrRotateNode } from "../../src/lib/operations/nodeCredentials";
import { prisma } from "../../src/lib/prisma";

async function createLocalCaptureSource(name: string) {
  return prisma.captureSource.create({
    data: {
      name,
      cameraDevice: "/dev/video0",
      captureDirectory: `/tmp/plantlab-test-${name}`,
      width: 1280,
      height: 720,
      photoIntervalMinutes: 60,
    },
  });
}

describe("getCoordinatorDashboardData", () => {
  it("reports an active node with a recent heartbeat, its camera count, and no failed jobs", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy", role: "camera-node", rotateCredential: true });
    await prisma.plantLabNode.update({ where: { id: registered.node.id }, data: { lastHeartbeatAt: new Date() } });
    await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "usb:1bcf:28c1", devicePath: "/dev/video0" },
    });

    const data = await getCoordinatorDashboardData(prisma);

    const node = data.nodes.find((entry) => entry.name === "bokchoy")!;
    expect(node.statusLabel).toBe("active");
    expect(node.cameraCount).toBe(1);
    expect(node.recentFailedJobCount).toBe(0);
  });

  it("does not count unavailable (unverified-capture) devices toward a node's camera count", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-pi-camera-count", role: "greenhouse-node", rotateCredential: true });
    await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "usb:real-webcam", devicePath: "/dev/video0", available: true },
    });
    // e.g. a Raspberry Pi's bcm2835-codec-decode/isp hardware helper
    // devices - each enumerates as its own V4L2 node but none of them is a
    // real, selectable camera (verifiedCapture is false for all of them).
    await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "platform:bcm2835-codec-decode", devicePath: "/dev/video10", available: false },
    });
    await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "platform:bcm2835-isp", devicePath: "/dev/video13", available: false },
    });

    const data = await getCoordinatorDashboardData(prisma);

    const node = data.nodes.find((entry) => entry.name === "greenhouse-pi-camera-count")!;
    expect(node.cameraCount).toBe(1);
  });

  it("reports an offline node when the heartbeat is stale", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "greenhouse-zero", role: "greenhouse-node", rotateCredential: true });
    await prisma.plantLabNode.update({
      where: { id: registered.node.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const data = await getCoordinatorDashboardData(prisma);

    const node = data.nodes.find((entry) => entry.name === "greenhouse-zero")!;
    expect(node.statusLabel).toBe("offline");
  });

  it("reports a node with no heartbeat yet as pending", async () => {
    await registerOrRotateNode(prisma, { name: "xps", role: "camera-node", rotateCredential: true });

    const data = await getCoordinatorDashboardData(prisma);

    const node = data.nodes.find((entry) => entry.name === "xps")!;
    expect(node.statusLabel).toBe("pending");
    expect(node.lastHeartbeatAt).toBeNull();
  });

  it("counts only recent (last 24h) failed jobs per node, not older history", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy-2", role: "camera-node", rotateCredential: true });
    const camera = await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "usb:1bcf:28c1", devicePath: "/dev/video0" },
    });
    const source = await createLocalCaptureSource("bokchoy-2-source");
    const assignment = await prisma.nodeCameraAssignment.create({
      data: {
        nodeId: registered.node.id,
        nodeCameraId: camera.id,
        captureSourceId: source.id,
        name: source.name,
        width: 1280,
        height: 720,
      },
    });
    const recentFailure = await prisma.agentCaptureJob.create({
      data: { nodeId: registered.node.id, assignmentId: assignment.id, captureSourceId: source.id, status: "failed" },
    });
    const oldFailure = await prisma.agentCaptureJob.create({
      data: { nodeId: registered.node.id, assignmentId: assignment.id, captureSourceId: source.id, status: "failed" },
    });
    await prisma.agentCaptureJob.update({
      where: { id: oldFailure.id },
      data: { updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
    // Sanity: the recent failure really is recent by the query's own clock.
    expect(recentFailure.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const data = await getCoordinatorDashboardData(prisma);

    const node = data.nodes.find((entry) => entry.name === "bokchoy-2")!;
    expect(node.recentFailedJobCount).toBe(1);
  });

  it("counts queued and claimed capture jobs separately in the job queue summary", async () => {
    const registered = await registerOrRotateNode(prisma, { name: "bokchoy-3", role: "camera-node", rotateCredential: true });
    const camera = await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "usb:1bcf:28c1", devicePath: "/dev/video0" },
    });
    const source = await createLocalCaptureSource("bokchoy-3-source");
    const assignment = await prisma.nodeCameraAssignment.create({
      data: {
        nodeId: registered.node.id,
        nodeCameraId: camera.id,
        captureSourceId: source.id,
        name: source.name,
        width: 1280,
        height: 720,
      },
    });
    await prisma.agentCaptureJob.create({
      data: { nodeId: registered.node.id, assignmentId: assignment.id, captureSourceId: source.id, status: "queued" },
    });
    await prisma.agentCaptureJob.create({
      data: { nodeId: registered.node.id, assignmentId: assignment.id, captureSourceId: source.id, status: "claimed" },
    });

    const data = await getCoordinatorDashboardData(prisma);

    expect(data.jobQueue.queued).toBe(1);
    expect(data.jobQueue.claimed).toBe(1);
  });

  it("only counts active capture sources that are not backed by any node camera as local", async () => {
    const before = await getCoordinatorDashboardData(prisma);

    const registered = await registerOrRotateNode(prisma, { name: "bokchoy-4", role: "camera-node", rotateCredential: true });
    const camera = await prisma.nodeCamera.create({
      data: { nodeId: registered.node.id, stableId: "usb:1bcf:28c1", devicePath: "/dev/video0" },
    });
    const nodeBackedSource = await createLocalCaptureSource("node-backed");
    await prisma.nodeCamera.update({ where: { id: camera.id }, data: { captureSourceId: nodeBackedSource.id } });
    await createLocalCaptureSource("truly-local");

    const after = await getCoordinatorDashboardData(prisma);

    // The node-backed source must not count as local; only "truly-local" adds to the total.
    expect(after.activeLocalCaptureSourceCount).toBe(before.activeLocalCaptureSourceCount + 1);
  });
});
