import "server-only";

import { getBillingDashboardData } from "@/lib/dashboard-data";
import BillingClient from "./BillingClient";

export const dynamic = "force-dynamic";

export default async function DashboardBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topupEventId?: string }>;
}) {
  const [data, params] = await Promise.all([
    getBillingDashboardData(),
    searchParams,
  ]);
  return (
    <BillingClient
      data={data}
      initialTopupEventId={params.topupEventId ?? null}
    />
  );
}
