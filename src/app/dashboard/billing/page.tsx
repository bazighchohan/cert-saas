import "server-only";

import Link from "next/link";
import { getOrgPlanAndUsage } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function DashboardBillingPage() {
  const { org, plan, eventsUsed, certificatesUsed } = await getOrgPlanAndUsage();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Billing & Plans
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Subscription management for <strong className="text-slate-900">{org.name}</strong>.
        </p>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
              Active Plan: {plan.name}
            </span>
            <h2 className="mt-3 text-lg font-bold text-slate-900">
              {plan.pricePkr === 0
                ? "PKR 0 / month"
                : `PKR ${plan.pricePkr.toLocaleString()} / month`}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {eventsUsed} / {plan.maxEvents ?? "∞"} events used ·{" "}
              {certificatesUsed} / {plan.maxCertificatesTotal ?? "∞"} total certificates issued
            </p>
          </div>

          <Link
            href="/dashboard/settings"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 shadow-xs transition hover:bg-slate-50"
          >
            View Detailed Usage in Settings →
          </Link>
        </div>

        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-600">
          Online plan upgrades (Starter plan: up to 10 events, 500 certificates/event, custom branding) will be enabled in the billing integration phase.
        </div>
      </section>
    </div>
  );
}
