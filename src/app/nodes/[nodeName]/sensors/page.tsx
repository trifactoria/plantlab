import Link from "next/link";
import { notFound } from "next/navigation";
import { SensorListPanel } from "@/components/SensorListPanel";
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
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Sensors</h1>
        </div>
      </header>

      <section className="section">
        <div className="container grid grid-cols-1 gap-4">
          <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
            Node hardware configuration will become editable after desired/applied configuration support is enabled.
          </p>
          <SensorListPanel nodeName={nodeName} />
        </div>
      </section>
    </main>
  );
}
