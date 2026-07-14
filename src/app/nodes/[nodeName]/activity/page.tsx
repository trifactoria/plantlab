import Link from "next/link";
import { notFound } from "next/navigation";
import { NodeTimelinePanel } from "@/components/NodeTimelinePanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function NodeActivityPage({ params }: { params: Promise<{ nodeName: string }> }) {
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
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Activity</h1>
        </div>
      </header>

      <section className="section">
        <div className="container">
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <NodeTimelinePanel nodeName={nodeName} />
          </div>
        </div>
      </section>
    </main>
  );
}
