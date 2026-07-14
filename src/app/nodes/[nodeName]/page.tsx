import Link from "next/link";
import { notFound } from "next/navigation";
import { GreenhousePanel } from "@/components/GreenhousePanel";
import { NodeDetailPanel } from "@/components/NodeDetailPanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function NodeDetailPage({ params }: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await params;
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) {
    notFound();
  }

  const [outletCount, sensorCount] = await Promise.all([
    prisma.nodeOutlet.count({ where: { nodeId: node.id } }),
    prisma.nodeSensor.count({ where: { nodeId: node.id } }),
  ]);
  const hasGreenhouseSubsystems = outletCount > 0 || sensorCount > 0;

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <Link href="/" className="text-sm font-semibold text-emerald-700">
            &larr; Coordinator
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">{nodeName}</h1>
        </div>
      </header>

      <section className="section">
        <div className="container grid grid-cols-1 gap-6">
          <NodeDetailPanel nodeName={nodeName} />
          {hasGreenhouseSubsystems ? <GreenhousePanel nodeName={nodeName} /> : null}
        </div>
      </section>
    </main>
  );
}
