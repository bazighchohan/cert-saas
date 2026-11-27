import "server-only";

import HelpGuidesContent from "@/components/marketing/HelpGuidesContent";
import { requireDashboardAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardHelpPage() {
  const { org } = await requireDashboardAuth();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Help &amp; Step-by-Step Guides
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          How to issue, manage, and track e-certificates for{" "}
          <strong className="text-slate-900">{org.name}</strong>.
        </p>
      </div>

      <HelpGuidesContent />
    </div>
  );
}
