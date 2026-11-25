import "server-only";

import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getSuperAdminPaymentRequestsData } from "@/lib/superadmin-data";
import PaymentsQueueClient from "./PaymentsQueueClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminPaymentsPage() {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const requests = await getSuperAdminPaymentRequestsData();
  return <PaymentsQueueClient requests={requests} />;
}
