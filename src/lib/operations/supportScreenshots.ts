import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScreenshotMetadata } from "./supportHealth";

if (typeof window !== "undefined") {
  throw new Error("src/lib/operations/supportScreenshots.ts is server-only operational code.");
}

export type SupportScreenshotRoute = {
  route: string;
  title: string;
  category: "dashboard" | "node" | "camera" | "sensor" | "project" | "support" | "photo" | "capture-source" | "setup" | "warning";
  host: string;
  readiness?: "environment" | "project" | "charts" | "hardware" | "generic";
};

export type SupportScreenshotDiscoverySnapshot = {
  host: string;
  projects?: Array<{ id: string; name?: string | null; photoId?: string | null }>;
  nodes?: Array<{ name: string; sensors?: Array<{ key: string }>; cameras?: Array<{ id: string }> }>;
  captureSources?: Array<{ id: string; name?: string | null }>;
  photos?: Array<{ id: string }>;
  warnings?: Array<{ route: string; title?: string | null }>;
};

export function discoverScreenshotRoutes(snapshot: SupportScreenshotDiscoverySnapshot): SupportScreenshotRoute[] {
  const routes: SupportScreenshotRoute[] = [
    { route: "/", title: "Dashboard", category: "dashboard", host: snapshot.host, readiness: "generic" },
    { route: "/?tab=environment", title: "Dashboard Environment", category: "dashboard", host: snapshot.host, readiness: "environment" },
    { route: "/?tab=projects", title: "Dashboard Projects", category: "dashboard", host: snapshot.host, readiness: "generic" },
    { route: "/?tab=power", title: "Dashboard Power", category: "dashboard", host: snapshot.host, readiness: "generic" },
    { route: "/?tab=cameras", title: "Dashboard Cameras", category: "dashboard", host: snapshot.host, readiness: "hardware" },
    { route: "/?tab=system", title: "Dashboard System", category: "dashboard", host: snapshot.host, readiness: "hardware" },
    { route: "/capture-sources", title: "Capture Sources", category: "capture-source", host: snapshot.host, readiness: "hardware" },
    { route: "/support", title: "Support", category: "support", host: snapshot.host, readiness: "generic" },
    { route: "/?support-create-project=1", title: "Project Creation", category: "setup", host: snapshot.host, readiness: "generic" },
  ];

  for (const node of snapshot.nodes ?? []) {
    const encodedNode = encodeURIComponent(node.name);
    routes.push(
      { route: `/nodes/${encodedNode}`, title: `Node ${node.name}`, category: "node", host: snapshot.host, readiness: "hardware" },
      { route: `/nodes/${encodedNode}/cameras`, title: `Node ${node.name} Cameras`, category: "camera", host: snapshot.host, readiness: "hardware" },
      { route: `/nodes/${encodedNode}/sensors`, title: `Node ${node.name} Sensors`, category: "sensor", host: snapshot.host, readiness: "environment" },
      { route: `/nodes/${encodedNode}/power`, title: `Node ${node.name} Power`, category: "node", host: snapshot.host, readiness: "generic" },
      { route: `/nodes/${encodedNode}/activity`, title: `Node ${node.name} Activity`, category: "node", host: snapshot.host, readiness: "generic" },
    );
    for (const sensor of node.sensors ?? []) {
      routes.push({
        route: `/nodes/${encodedNode}/sensors/${encodeURIComponent(sensor.key)}`,
        title: `Sensor ${node.name}/${sensor.key}`,
        category: "sensor",
        host: snapshot.host,
        readiness: "environment",
      });
    }
  }

  for (const project of snapshot.projects ?? []) {
    const encodedProject = encodeURIComponent(project.id);
    routes.push(
      { route: `/projects/${encodedProject}`, title: project.name ? `${project.name} Overview` : "Project Overview", category: "project", host: snapshot.host, readiness: "project" },
      { route: `/projects/${encodedProject}?tab=photos`, title: project.name ? `${project.name} Photos` : "Project Photos", category: "project", host: snapshot.host, readiness: "project" },
      { route: `/projects/${encodedProject}?tab=camera`, title: project.name ? `${project.name} Camera Tab` : "Project Camera Tab", category: "project", host: snapshot.host, readiness: "hardware" },
      { route: `/projects/${encodedProject}/camera`, title: project.name ? `${project.name} Camera Setup` : "Project Camera Setup", category: "project", host: snapshot.host, readiness: "hardware" },
      { route: `/projects/${encodedProject}?tab=environment`, title: project.name ? `${project.name} Environment` : "Project Environment", category: "project", host: snapshot.host, readiness: "environment" },
      { route: `/projects/${encodedProject}?tab=settings`, title: project.name ? `${project.name} Settings Tab` : "Project Settings Tab", category: "project", host: snapshot.host, readiness: "project" },
      { route: `/projects/${encodedProject}/settings`, title: project.name ? `${project.name} Settings Page` : "Project Settings Page", category: "project", host: snapshot.host, readiness: "project" },
    );
    if (project.photoId) {
      routes.push({ route: `/photos/${encodeURIComponent(project.photoId)}`, title: `${project.name ?? "Project"} Representative Photo`, category: "photo", host: snapshot.host, readiness: "generic" });
    }
  }

  for (const source of snapshot.captureSources ?? []) {
    routes.push({
      route: `/capture-sources/${encodeURIComponent(source.id)}`,
      title: source.name ? `Capture Source ${source.name}` : "Capture Source",
      category: "capture-source",
      host: snapshot.host,
      readiness: "hardware",
    });
  }

  for (const photo of snapshot.photos ?? []) {
    routes.push({ route: `/photos/${encodeURIComponent(photo.id)}`, title: "Representative Photo", category: "photo", host: snapshot.host, readiness: "generic" });
  }

  for (const warning of snapshot.warnings ?? []) {
    routes.push({
      route: warning.route,
      title: warning.title ?? `Warning surface ${warning.route}`,
      category: "warning",
      host: snapshot.host,
      readiness: "generic",
    });
  }

  return dedupeRoutes(routes);
}

export async function writeScreenshotRouteManifest(filePath: string, routes: SupportScreenshotRoute[]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ routes }, null, 2)}\n`);
}

export function summarizeScreenshotMetadata(metadata: ScreenshotMetadata[]) {
  return {
    total: metadata.length,
    ready: metadata.filter((item) => item.ready).length,
    notReady: metadata.filter((item) => !item.ready).length,
    consoleErrorCount: metadata.reduce((sum, item) => sum + item.consoleErrors.length, 0),
    networkErrorCount: metadata.reduce((sum, item) => sum + item.networkErrors.length, 0),
    routes: metadata.map((item) => ({ host: item.host, route: item.route, file: item.outputFilename, ready: item.ready, status: item.httpStatus })),
  };
}

function dedupeRoutes(routes: SupportScreenshotRoute[]) {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.host}:${route.route}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
