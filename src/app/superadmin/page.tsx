import "server-only";

import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getPlatformOverviewData } from "@/lib/superadmin-data";
import PlatformOverviewClient from "./PlatformOverviewClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminOverviewPage() {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const data = await getPlatformOverviewData();
  return <PlatformOverviewClient data={data} />;
}
