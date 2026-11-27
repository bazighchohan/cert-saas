import "server-only";

import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getSuperAdminSignupRequestsData } from "@/lib/superadmin-data";
import RequestsQueueClient from "./RequestsQueueClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminRequestsPage() {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const data = await getSuperAdminSignupRequestsData();
  return <RequestsQueueClient data={data} />;
}
