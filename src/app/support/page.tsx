import Link from "next/link";
import { SupportBundlePanel } from "@/components/SupportBundlePanel";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const nodes = await prisma.plantLabNode.findMany({ select: { name: true }, orderBy: { name: "asc" } });

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="container py-6">
          <Link href="/" className="text-sm font-semibold text-emerald-700">
            &larr; Coordinator
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-stone-950">Support bundles</h1>
          <p className="mt-1 text-sm text-stone-600">Generate a redacted, read-only diagnostics archive for the coordinator and nodes. One offline host yields a partial bundle rather than aborting the whole run.</p>
        </div>
      </header>

      <section className="section">
        <div className="container grid grid-cols-1 gap-4">
          <SupportBundlePanel nodeNames={nodes.map((node) => node.name)} />
        </div>
      </section>
    </main>
  );
}
