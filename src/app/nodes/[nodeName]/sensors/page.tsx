import Link from "next/link";
import { notFound } from "next/navigation";
import { SensorManagementPanel } from "@/components/SensorManagementPanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function NodeSensorsPage({ params }: { params: Promise<{ nodeName: string }> }) {
  const { nodeName } = await params;
  const node = await prisma.plantLabNode.findUnique({ where: { name: nodeName } });
  if (!node) {
    notFound();
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <Link href={`/nodes/${nodeName}`} className="text-sm font-semibold text-emerald-700">
            &larr; {nodeName}
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Sensor management</h1>
          <p className="mt-1 text-sm text-stone-600">
            Edit the desired sensor configuration, then apply it. The node validates and reports back applied or rejected - readings and diagnostic history are always preserved.
          </p>
        </div>
      </header>

      <section className="section">
        <div className="container grid grid-cols-1 gap-4">
          <SensorManagementPanel nodeName={nodeName} />
        </div>
      </section>
    </main>
  );
}
