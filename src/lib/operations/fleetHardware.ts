import type { Prisma, PrismaClient } from "@prisma/client";
import { canDiscoverLocalCameraHardware } from "../localOnly";
import { nextPermittedCaptureTime } from "../schedule";
import { discoverLocalCameras, type LocalCamera } from "../v4l2";
import { computeCameraStatus, type CameraStatus } from "../hardware/cameraStatus";
import { DEFAULT_SENSOR_HEALTH_THRESHOLDS, evaluateSensorHealth, type SensorHealth } from "../hardware/sensorHealth";
import { flattenCameraModes, normalizeCameraInputFormat, preferredCameraMode } from "../cameraModes";
import { parseCapabilities } from "./capabilities";
import { readNodeConfig } from "./config";
import { createManualCaptureJob, waitForJobCompletion } from "./manualCapture";
import { computeNodeStatus } from "./nodeCredentials";
import { nodeCameraBaseDisplayName, parseNodeCameraFormats, updateCameraAssignmentConfig } from "./nodeCameras";
import { sensorDisplayName } from "./sensorConfig";
import { captureSourcePhoto } from "../sourceCapture";
import { captureSourceConfigUpdateData, serializeDailyWindow } from "./captureSourceConfig";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/fleetHardware.ts is server-only operational code.");
}

export type FleetCameraSummary = {
  id: string;
  stableId: string;
  displayName: string;
  reportedName: string | null;
  node: { id: string; name: string; role: string; online: boolean; capabilities: string[]; localToCoordinator: boolean };
  available: boolean;
  enabled: boolean;
  retired: boolean;
  status: CameraStatus;
  statusReason: string | null;
  usableForCapture: boolean;
  captureSourceId: string | null;
  assignmentId: string | null;
  currentMode: { width: number; height: number; inputFormat: string; frameRate: string | null } | null;
  supportedModes: Array<{ width: number; height: number; inputFormat: string; frameRates: string[] }>;
  orientation: { rotation: 0 | 90 | 180 | 270; flipHorizontal: boolean; flipVertical: boolean };
  schedule: {
    enabled: boolean;
    intervalMinutes: number | null;
    timeZone: string | null;
    dailyWindow: { enabled: boolean; start: string | null; end: string | null; crossesMidnight: boolean };
    nextCaptureAt: string | null;
  } | null;
  illumination: {
    policy: "unrestricted" | "only-while-on";
    outletId: string | null;
    outletKey: string | null;
    outletLabel: string | null;
    observedState: boolean | null;
    observedAt: string | null;
  } | null;
  reliability: {
    warmupFrames: number | null;
    warmupSeconds: number | null;
    captureAttempts: number | null;
    fallbackMode: { width: number; height: number; inputFormat: string | null; frameRate: string | null; attempts: number } | null;
    persistentFallbackAllowed: false;
  };
  lastCaptureAt: string | null;
  lastCaptureStatus: string | null;
  lastCaptureFallbackUsed: boolean | null;
  configurationUrl: string;
  detailsUrl: string;
  diagnosticsUrl: string;
};

export type FleetSensorSummary = {
  id: string;
  key: string;
  displayName: string;
  reportedName: string | null;
  node: { id: string; name: string; role: string; online: boolean; capabilities: string[] };
  type: string;
  gpio: number | null;
  placement: string | null;
  enabled: boolean;
  configuredActive: boolean;
  retired: boolean;
  desiredConfigRevision: number | null;
  appliedConfigRevision: number | null;
  configState: "applied" | "pending" | "rejected" | "unknown";
  currentReading: { capturedAt: string; temperatureC: number | null; humidityPct: number | null; classification: string } | null;
  health: SensorHealth;
  lastDiagnostic: { capturedAt: string; code: string | null; message: string | null; classification: string } | null;
  configurationUrl: string;
  detailsUrl: string;
  historyUrl: string;
};

const CAMERA_INCLUDE = {
  node: { include: { credentials: { where: { revokedAt: null }, select: { id: true } } } },
  endpoints: { orderBy: [{ available: "desc" as const }, { observedAt: "desc" as const }], take: 1 },
  assignments: {
    where: { active: true },
    include: {
      captureSource: {
        include: {
          illuminationOutlet: true,
          sourceCaptures: { orderBy: { timestamp: "desc" as const }, take: 1 },
        },
      },
      jobs: { orderBy: { requestedAt: "desc" as const }, take: 1 },
    },
    orderBy: { updatedAt: "desc" as const },
    take: 1,
  },
} satisfies Prisma.NodeCameraInclude;

type CameraWithFleetRelations = Prisma.NodeCameraGetPayload<{ include: typeof CAMERA_INCLUDE }>;

export async function listFleetCameras(prisma: PrismaClient, options: { includeLocalDiscovery?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const nodeConfig = await readNodeConfig();
  const localNodeName = nodeConfig?.nodeName ?? nodeConfig?.hostname ?? null;
  const dbCameras = await prisma.nodeCamera.findMany({
    include: CAMERA_INCLUDE,
    orderBy: [{ node: { name: "asc" } }, { retiredAt: "asc" }, { available: "desc" }, { displayName: "asc" }, { reportedName: "asc" }],
  });
  const summaries = dbCameras.map((camera) => serializeFleetCamera(camera, { now, localNodeName }));
  if (options.includeLocalDiscovery !== false && canDiscoverLocalCameraHardware()) {
    const local = await discoverLocalFleetCameras(nodeConfig).catch(() => []);
    const existingStableIds = new Set(summaries.map((camera) => camera.stableId));
    for (const camera of local) {
      if (!existingStableIds.has(camera.stableId)) summaries.push(camera);
    }
  }
  return summaries;
}

export function serializeFleetCamera(camera: CameraWithFleetRelations, options: { now?: Date; localNodeName?: string | null } = {}): FleetCameraSummary {
  const now = options.now ?? new Date();
  const activeCredential = camera.node.credentials.length > 0;
  const online = computeNodeStatus(camera.node, activeCredential, now) === "active";
  const assignment = camera.assignments[0] ?? null;
  const source = assignment?.captureSource ?? null;
  const endpoint = camera.endpoints[0] ?? null;
  const status = computeCameraStatus({
    nodeOnline: online,
    cameraAvailable: camera.available,
    cameraEnabled: camera.enabled,
    cameraRetired: Boolean(camera.retiredAt),
    assignmentActive: assignment?.active ?? true,
    captureSourceActive: source?.active ?? true,
    currentEndpointAvailable: endpoint ? endpoint.available : camera.available,
  });
  const formats = parseNodeCameraFormats(camera);
  const recentJob = assignment?.jobs[0] ?? null;
  const latestSourceCapture = source?.sourceCaptures[0] ?? null;
  return {
    id: camera.id,
    stableId: camera.stableId,
    displayName: nodeCameraBaseDisplayName(camera),
    reportedName: camera.reportedName,
    node: {
      id: camera.node.id,
      name: camera.node.name,
      role: camera.node.role,
      online,
      capabilities: parseCapabilities(camera.node.capabilitiesJson),
      localToCoordinator: Boolean(options.localNodeName && camera.node.name === options.localNodeName),
    },
    available: camera.available,
    enabled: camera.enabled,
    retired: Boolean(camera.retiredAt),
    status: status.status,
    statusReason: status.reason,
    usableForCapture: status.usableForCapture,
    captureSourceId: source?.id ?? camera.captureSourceId,
    assignmentId: assignment?.id ?? null,
    currentMode: assignment
      ? { width: assignment.width, height: assignment.height, inputFormat: assignment.inputFormat, frameRate: assignment.frameRate }
      : null,
    supportedModes: flattenCameraModes(formats),
    orientation: {
      rotation: normalizeRotation(source?.rotation ?? 0),
      flipHorizontal: source?.flipHorizontal ?? false,
      flipVertical: source?.flipVertical ?? false,
    },
    schedule: source
      ? {
          enabled: source.active,
          intervalMinutes: source.photoIntervalMinutes,
          timeZone: source.timeZone,
          dailyWindow: serializeDailyWindow(source),
          nextCaptureAt: nextSourceCaptureAt(source, now),
        }
      : null,
    illumination: source
      ? {
          policy: source.illuminationPolicy === "only-while-on" ? "only-while-on" : "unrestricted",
          outletId: source.illuminationOutletId,
          outletKey: source.illuminationOutlet?.key ?? null,
          outletLabel: source.illuminationOutlet?.name ?? null,
          observedState: source.illuminationOutlet?.actualState ?? null,
          observedAt: source.illuminationOutlet?.stateObservedAt?.toISOString() ?? null,
        }
      : null,
    reliability: {
      warmupFrames: assignment?.warmupFrames ?? null,
      warmupSeconds: assignment?.warmupSeconds ?? null,
      captureAttempts: assignment?.captureAttempts ?? null,
      fallbackMode:
        assignment?.fallbackWidth && assignment.fallbackHeight
          ? {
              width: assignment.fallbackWidth,
              height: assignment.fallbackHeight,
              inputFormat: assignment.fallbackInputFormat,
              frameRate: assignment.fallbackFrameRate,
              attempts: assignment.fallbackAttempts,
            }
          : null,
      persistentFallbackAllowed: false,
    },
    lastCaptureAt: latestSourceCapture?.timestamp.toISOString() ?? recentJob?.completedAt?.toISOString() ?? null,
    lastCaptureStatus: recentJob?.status ?? null,
    lastCaptureFallbackUsed: recentJob?.fallbackUsed ?? null,
    configurationUrl: `/nodes/${encodeURIComponent(camera.node.name)}/cameras`,
    detailsUrl: `/nodes/${encodeURIComponent(camera.node.name)}/cameras`,
    diagnosticsUrl: `/nodes/${encodeURIComponent(camera.node.name)}/cameras`,
  };
}

export async function listFleetSensors(prisma: PrismaClient, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const sensors = await prisma.nodeSensor.findMany({
    include: {
      node: { include: { credentials: { where: { revokedAt: null }, select: { id: true } } } },
      diagnostics: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
    orderBy: [{ node: { name: "asc" } }, { placement: "asc" }, { key: "asc" }],
  });
  return Promise.all(sensors.map((sensor) => serializeFleetSensor(prisma, sensor, now)));
}

type SensorWithFleetRelations = Prisma.NodeSensorGetPayload<{
  include: { node: { include: { credentials: { where: { revokedAt: null }; select: { id: true } } } }; diagnostics: true };
}>;

export async function serializeFleetSensor(prisma: PrismaClient, sensor: SensorWithFleetRelations, now: Date): Promise<FleetSensorSummary> {
  const activeCredential = sensor.node.credentials.length > 0;
  const nodeOnline = computeNodeStatus(sensor.node, activeCredential, now) === "active";
  const recentSince = new Date(now.getTime() - 5 * 60_000);
  const [recentSuccessCount, recentFailureCount] = await Promise.all([
    prisma.sensorReading.count({ where: { sensorId: sensor.id, capturedAt: { gte: recentSince } } }),
    prisma.sensorDiagnostic.count({ where: { sensorId: sensor.id, capturedAt: { gte: recentSince } } }),
  ]);
  const failureDurationSeconds =
    sensor.lastAttemptAt && (!sensor.lastAcceptedAt || sensor.lastAttemptAt > sensor.lastAcceptedAt)
      ? Math.max(0, Math.round((now.getTime() - (sensor.lastAcceptedAt ?? sensor.lastAttemptAt).getTime()) / 1000))
      : null;
  const health = evaluateSensorHealth(
    {
      nodeOnline,
      enabled: sensor.enabled,
      configuredActive: sensor.configuredActive,
      retired: Boolean(sensor.retiredAt),
      now,
      samplingIntervalSeconds: null,
      lastAcceptedAt: sensor.lastAcceptedAt,
      lastAttemptAt: sensor.lastAttemptAt,
      recentSuccessCount,
      recentFailureCount,
      consecutiveFailures: sensor.consecutiveFailures,
      consecutiveRejects: sensor.consecutiveRejects,
      failureDurationSeconds,
    },
    DEFAULT_SENSOR_HEALTH_THRESHOLDS,
  );
  const lastDiagnostic = sensor.diagnostics[0] ?? null;
  const currentReading = sensor.lastAttemptAt
    ? {
        capturedAt: sensor.lastAttemptAt.toISOString(),
        temperatureC: sensor.latestTemperatureC,
        humidityPct: sensor.latestHumidityPct,
        classification: sensor.latestClassification ?? "unknown",
      }
    : null;
  return {
    id: sensor.id,
    key: sensor.key,
    displayName: sensorDisplayName(sensor),
    reportedName: sensor.reportedName,
    node: { id: sensor.node.id, name: sensor.node.name, role: sensor.node.role, online: nodeOnline, capabilities: parseCapabilities(sensor.node.capabilitiesJson) },
    type: sensor.type,
    gpio: sensor.gpio,
    placement: sensor.placement,
    enabled: sensor.enabled,
    configuredActive: sensor.configuredActive,
    retired: Boolean(sensor.retiredAt),
    desiredConfigRevision: sensor.desiredConfigRevision,
    appliedConfigRevision: sensor.appliedConfigRevision,
    configState: sensor.node.appliedSensorConfigStatus === "applied" || sensor.node.appliedSensorConfigStatus === "pending" || sensor.node.appliedSensorConfigStatus === "rejected"
      ? sensor.node.appliedSensorConfigStatus
      : "unknown",
    currentReading,
    health,
    lastDiagnostic: lastDiagnostic
      ? {
          capturedAt: lastDiagnostic.capturedAt.toISOString(),
          code: lastDiagnostic.code,
          message: lastDiagnostic.message,
          classification: lastDiagnostic.classification,
        }
      : null,
    configurationUrl: `/nodes/${encodeURIComponent(sensor.node.name)}/sensors`,
    detailsUrl: `/nodes/${encodeURIComponent(sensor.node.name)}/sensors/${encodeURIComponent(sensor.key)}`,
    historyUrl: `/nodes/${encodeURIComponent(sensor.node.name)}/sensors/${encodeURIComponent(sensor.key)}`,
  };
}

export type ConfigureFleetCameraInput = {
  cameraId: string;
  displayName?: string;
  enabled?: boolean;
  assignmentId?: string;
  captureSourceId?: string;
  captureSourceName?: string;
  assignmentName?: string;
  resolution?: { width: number; height: number };
  inputFormat?: string;
  frameRate?: string | null;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  warmupFrames?: number;
  warmupSeconds?: number | null;
  captureAttempts?: number;
  fallbackMode?: { width: number; height: number; inputFormat?: string | null; frameRate?: string | null; attempts?: number } | null;
  serializeOnNode?: boolean;
  schedule?: { enabled?: boolean; intervalMinutes?: number; startAt?: Date };
  timeZone?: string;
  dailyWindowEnabled?: boolean;
  dailyWindowStartMinutes?: number | null;
  dailyWindowEndMinutes?: number | null;
  illumination?: { outletId?: string | null; policy?: "unrestricted" | "only-while-on" };
};

export async function configureFleetCamera(prisma: PrismaClient, input: ConfigureFleetCameraInput) {
  const camera = await prisma.nodeCamera.findUniqueOrThrow({ where: { id: input.cameraId }, include: { node: true, assignments: { where: { active: true }, orderBy: { updatedAt: "desc" }, take: 1 } } });
  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    await prisma.nodeCamera.update({ where: { id: camera.id }, data: { displayName, name: displayName } });
  }
  if (input.enabled !== undefined) {
    await prisma.nodeCamera.update({ where: { id: camera.id }, data: { enabled: input.enabled } });
  }
  const assignmentId = input.assignmentId ?? camera.assignments[0]?.id ?? null;
  if (assignmentId) {
    await updateCameraAssignmentConfig(prisma, {
      nodeName: camera.node.name,
      assignmentId,
      name: input.assignmentName,
      width: input.resolution?.width,
      height: input.resolution?.height,
      inputFormat: input.inputFormat,
      frameRate: input.frameRate,
      warmupFrames: input.warmupFrames,
      warmupSeconds: input.warmupSeconds,
      captureAttempts: input.captureAttempts,
      fallbackWidth: input.fallbackMode === null ? null : input.fallbackMode?.width,
      fallbackHeight: input.fallbackMode === null ? null : input.fallbackMode?.height,
      fallbackInputFormat: input.fallbackMode === null ? null : input.fallbackMode?.inputFormat,
      fallbackFrameRate: input.fallbackMode === null ? null : input.fallbackMode?.frameRate,
      fallbackAttempts: input.fallbackMode?.attempts,
      serializeOnNode: input.serializeOnNode,
      requestedBy: "fleet-camera-config",
    });
  }
  if (
    input.captureSourceId ||
    input.captureSourceName !== undefined ||
    input.rotation !== undefined ||
    input.flipHorizontal !== undefined ||
    input.flipVertical !== undefined ||
    input.schedule ||
    input.timeZone !== undefined ||
    input.dailyWindowEnabled !== undefined ||
    input.dailyWindowStartMinutes !== undefined ||
    input.dailyWindowEndMinutes !== undefined ||
    input.illumination
  ) {
    const captureSourceId = input.captureSourceId ?? camera.assignments[0]?.captureSourceId ?? camera.captureSourceId;
    if (captureSourceId) {
      const configData = await captureSourceConfigUpdateData(prisma, captureSourceId, {
        name: input.captureSourceName,
        active: input.schedule?.enabled,
        intervalMinutes: input.schedule?.intervalMinutes,
        timeZone: input.timeZone,
        dailyWindowEnabled: input.dailyWindowEnabled,
        dailyWindowStartMinutes: input.dailyWindowStartMinutes,
        dailyWindowEndMinutes: input.dailyWindowEndMinutes,
        illuminationOutletId: input.illumination?.outletId,
        illuminationPolicy: input.illumination?.policy,
      });
      await prisma.captureSource.update({
        where: { id: captureSourceId },
        data: {
          ...configData,
          rotation: input.rotation,
          flipHorizontal: input.flipHorizontal,
          flipVertical: input.flipVertical,
          captureStartAt: input.schedule?.startAt,
        },
      });
    }
  }
  return prisma.nodeCamera.findUniqueOrThrow({ where: { id: input.cameraId }, include: CAMERA_INCLUDE });
}

export type TestFleetCameraCaptureInput = {
  cameraId?: string;
  captureSourceId?: string;
  assignmentId?: string;
  nodeName?: string;
  waitForCompletion?: boolean;
};

export async function testFleetCameraCapture(prisma: PrismaClient, input: TestFleetCameraCaptureInput) {
  const assignment = await resolveTestAssignment(prisma, input);
  if (assignment) {
    const { job, reused } = await createManualCaptureJob(prisma, { nodeName: assignment.node.name, assignmentId: assignment.id });
    if (!input.waitForCompletion) {
      return {
        mode: "remote-node" as const,
        status: job.status,
        jobId: job.id,
        reused,
        requestedMode: { width: assignment.width, height: assignment.height, inputFormat: assignment.inputFormat, frameRate: assignment.frameRate },
        effectiveMode: null,
        fallbackUsed: null,
        sourceCaptureId: job.sourceCaptureId,
      };
    }
    const completed = await waitForJobCompletion(prisma, job.id);
    return {
      mode: "remote-node" as const,
      status: completed?.status ?? "timeout",
      jobId: job.id,
      reused,
      requestedMode: { width: assignment.width, height: assignment.height, inputFormat: assignment.inputFormat, frameRate: assignment.frameRate },
      effectiveMode: completed?.effectiveWidth && completed.effectiveHeight && completed.effectiveInputFormat
        ? { width: completed.effectiveWidth, height: completed.effectiveHeight, inputFormat: completed.effectiveInputFormat, frameRate: completed.effectiveFrameRate }
        : null,
      fallbackUsed: completed?.fallbackUsed ?? null,
      sourceCaptureId: completed?.sourceCaptureId ?? null,
    };
  }

  if (!input.captureSourceId) throw new Error("A local test capture requires a captureSourceId.");
  if (!canDiscoverLocalCameraHardware()) throw new Error("Local camera hardware discovery/execution is not enabled for this process.");
  const captured = await captureSourcePhoto(input.captureSourceId);
  return {
    mode: "local" as const,
    status: "completed",
    jobId: null,
    reused: false,
    requestedMode: null,
    effectiveMode: {
      width: captured.sourceCapture.originalWidth,
      height: captured.sourceCapture.originalHeight,
      inputFormat: captured.sourceCapture.pixelFormat ?? "unknown",
      frameRate: null,
    },
    fallbackUsed: false,
    sourceCaptureId: captured.sourceCapture.id,
  };
}

async function resolveTestAssignment(prisma: PrismaClient, input: TestFleetCameraCaptureInput) {
  if (input.assignmentId) {
    return prisma.nodeCameraAssignment.findFirst({ where: { id: input.assignmentId, ...(input.nodeName ? { node: { name: input.nodeName } } : {}) }, include: { node: true } });
  }
  if (input.cameraId) {
    return prisma.nodeCameraAssignment.findFirst({ where: { nodeCameraId: input.cameraId, active: true }, include: { node: true }, orderBy: { updatedAt: "desc" } });
  }
  if (input.captureSourceId) {
    return prisma.nodeCameraAssignment.findFirst({ where: { captureSourceId: input.captureSourceId, active: true }, include: { node: true }, orderBy: { updatedAt: "desc" } });
  }
  return null;
}

async function discoverLocalFleetCameras(nodeConfig: Awaited<ReturnType<typeof readNodeConfig>>): Promise<FleetCameraSummary[]> {
  const cameras =
    process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1"
      ? [
          {
            name: "Mock USB Camera",
            device: "/dev/video-test",
            supportsCapture: true,
            stableId: "usb:1234:5678:MOCKSERIAL",
            formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1920, height: 1080, frameRates: ["30 fps"] }] }],
          } satisfies LocalCamera,
        ]
      : await discoverLocalCameras();
  const nodeName = nodeConfig?.nodeName ?? nodeConfig?.hostname ?? "local";
  const nodeRole = nodeConfig?.role ?? "standalone";
  return cameras.map((camera) => serializeLocalDiscoveryCamera(camera, { nodeName, nodeRole }));
}

function serializeLocalDiscoveryCamera(camera: LocalCamera, input: { nodeName: string; nodeRole: string }): FleetCameraSummary {
  const preferred = camera.verifiedFormat
    ? { width: camera.verifiedFormat.width, height: camera.verifiedFormat.height, inputFormat: normalizeCameraInputFormat(camera.verifiedFormat.pixelFormat), frameRate: null }
    : (() => {
        const mode = preferredCameraMode(camera.formats ?? []);
        return mode ? { width: mode.width, height: mode.height, inputFormat: mode.inputFormat, frameRate: mode.frameRates[0] ?? null } : null;
      })();
  const available = camera.verifiedCapture ?? camera.supportsCapture;
  const status = computeCameraStatus({
    nodeOnline: true,
    cameraAvailable: available,
    cameraEnabled: true,
    cameraRetired: false,
    assignmentActive: true,
    captureSourceActive: true,
    currentEndpointAvailable: available,
  });
  const stableId = camera.stableId ?? `local:${camera.device}`;
  return {
    id: `local:${stableId}`,
    stableId,
    displayName: camera.name || "Local camera",
    reportedName: camera.name || null,
    node: { id: "local", name: input.nodeName, role: input.nodeRole, online: true, capabilities: ["camera"], localToCoordinator: true },
    available,
    enabled: true,
    retired: false,
    status: status.status,
    statusReason: status.reason,
    usableForCapture: status.usableForCapture,
    captureSourceId: null,
    assignmentId: null,
    currentMode: preferred,
    supportedModes: flattenCameraModes(camera.formats ?? []),
    orientation: { rotation: 0, flipHorizontal: false, flipVertical: false },
    schedule: null,
    illumination: null,
    reliability: { warmupFrames: null, warmupSeconds: null, captureAttempts: null, fallbackMode: null, persistentFallbackAllowed: false },
    lastCaptureAt: null,
    lastCaptureStatus: null,
    lastCaptureFallbackUsed: null,
    configurationUrl: "/capture-sources",
    detailsUrl: "/capture-sources",
    diagnosticsUrl: "/api/cameras",
  };
}

function nextSourceCaptureAt(source: NonNullable<CameraWithFleetRelations["assignments"][number]["captureSource"]>, now: Date) {
  if (!source.active) return null;
  const next = nextPermittedCaptureTime({
    startAt: source.captureStartAt,
    intervalMinutes: source.photoIntervalMinutes,
    timeZone: source.timeZone,
    captureWindowEnabled: source.captureWindowEnabled,
    captureWindowStartMinutes: source.captureWindowStartMinutes,
    captureWindowEndMinutes: source.captureWindowEndMinutes,
    now,
  });
  return next?.toISOString() ?? null;
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}
