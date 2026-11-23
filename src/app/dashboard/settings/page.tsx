import "server-only";

import { notFound } from "next/navigation";
import { getOrgPlanAndUsage } from "@/lib/dashboard-data";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function DashboardSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ orgId?: string; org?: string }>;
}) {
  const [summary, params] = await Promise.all([
    getOrgPlanAndUsage(),
    searchParams,
  ]);

  // Tenant isolation guard: reject any attempt to load another org's settings.
  if (
    (params.orgId && params.orgId !== summary.org.id) ||
    (params.org && params.org !== summary.org.slug)
  ) {
    notFound();
  }

  return <SettingsClient summary={summary} />;
}
