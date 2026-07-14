import Link from "next/link";
import { notFound } from "next/navigation";
import { SensorDetailPanel } from "@/components/SensorDetailPanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SensorDetailPage({ params }: { params: Promise<{ nodeName: string; sensorKey: string }> }) {
  const { nodeName, sensorKey } = await params;
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) {
    notFound();
  }
  const sensor = await prisma.nodeSensor.findUnique({ where: { nodeId_key: { nodeId: node.id, key: sensorKey } } });
  if (!sensor) {
    notFound();
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <Link href={`/nodes/${nodeName}`} className="text-sm font-semibold text-emerald-700">
            &larr; {nodeName}
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">{sensor.name}</h1>
        </div>
      </header>

      <section className="section">
        <div className="container">
          <SensorDetailPanel nodeName={nodeName} sensorKey={sensorKey} />
        </div>
      </section>
    </main>
  );
}
