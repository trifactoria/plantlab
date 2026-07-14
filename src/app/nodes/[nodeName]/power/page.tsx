import Link from "next/link";
import { notFound } from "next/navigation";
import { PowerControlPanel } from "@/components/PowerControlPanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function NodePowerPage({ params }: { params: Promise<{ nodeName: string }> }) {
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
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Power</h1>
        </div>
      </header>

      <section className="section">
        <div className="container grid grid-cols-1 gap-4">
          <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
            Adding or removing outlets will become available after desired/applied configuration support is enabled. Manual control and timers for
            currently-configured outlets are fully functional below.
          </p>
          <PowerControlPanel nodeName={nodeName} />
        </div>
      </section>
    </main>
  );
}
