import { AppHeader } from "@/components/shell/AppHeader";
import { HomeDashboard } from "@/components/dashboard/HomeDashboard";
import { getNodeSummaries } from "@/lib/operations/nodeSummary";
import { readNodeConfig } from "@/lib/operations/config";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MODE_LABELS: Record<string, string> = {
  coordinator: "Coordinator",
  standalone: "Standalone",
  "camera-node": "Camera node",
  "greenhouse-node": "Greenhouse node",
};

type PageProps = {
  searchParams?: Promise<{ tab?: string | string[] }>;
};

export default async function HomePage({ searchParams }: PageProps) {
  const resolvedSearch = (await searchParams) ?? {};
  const initialTab = Array.isArray(resolvedSearch.tab) ? resolvedSearch.tab[0] : resolvedSearch.tab;

  const [nodeSummary, projectRecords, nodeConfig, outletNodes, allNodes] = await Promise.all([
    getNodeSummaries(prisma),
    prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { plants: true, photos: true, events: true } } },
    }),
    readNodeConfig(),
    prisma.plantLabNode.findMany({ where: { outlets: { some: {} } }, select: { name: true }, orderBy: { name: "asc" } }),
    prisma.plantLabNode.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
  ]);

  const powerNodeNames = outletNodes.map((node) => node.name);
  const powerNodeSet = new Set(powerNodeNames);

  // Nodes with at least one active sensor get an Environment panel; those that
  // also have outlets additionally get a power-state overlay on their charts.
  const environmentNodes = nodeSummary.nodes
    .filter((node) => node.resources.sensors.count > 0)
    .map((node) => ({ name: node.name, hasOutlets: powerNodeSet.has(node.name) }));

  const projects = projectRecords.map((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    gridWidth: project.gridWidth,
    gridHeight: project.gridHeight,
    isTestProject: project.isTestProject,
    createdAt: project.createdAt.toISOString(),
    counts: { photos: project._count.photos, plants: project._count.plants, events: project._count.events },
  }));

  const selfRow = nodeSummary.nodes.find((node) => node.relationship === "self");
  const systemInfo = {
    installationName: selfRow?.displayName ?? nodeConfig?.hostname ?? "This installation",
    mode: MODE_LABELS[nodeConfig?.role ?? "standalone"] ?? "Standalone",
    hostname: nodeConfig?.hostname ?? selfRow?.name ?? "unknown",
    attachedNodeCount: nodeSummary.nodes.filter((node) => node.relationship === "attached").length,
    coordinator: nodeConfig?.role === "coordinator",
  };

  return (
    <main className="min-h-screen bg-stone-50">
      <AppHeader />
      <section className="section">
        <div className="container">
          <HomeDashboard
            nodeSummary={nodeSummary}
            projects={projects}
            environmentNodes={environmentNodes}
            powerNodeNames={powerNodeNames}
            systemInfo={systemInfo}
            allNodeNames={allNodes.map((node) => node.name)}
            initialTab={initialTab}
          />
        </div>
      </section>
    </main>
  );
}
