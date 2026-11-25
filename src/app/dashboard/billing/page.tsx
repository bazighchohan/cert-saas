import "server-only";

import { getBillingDashboardData } from "@/lib/dashboard-data";
import BillingClient from "./BillingClient";

export const dynamic = "force-dynamic";

export default async function DashboardBillingPage() {
  const data = await getBillingDashboardData();
  return <BillingClient data={data} />;
}
