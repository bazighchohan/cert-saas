import "server-only";

import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getSuperAdminOrganizationsData } from "@/lib/superadmin-data";
import OrganizationsListClient from "./OrganizationsListClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminOrganizationsPage() {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const { organizations, plans } = await getSuperAdminOrganizationsData();
  return <OrganizationsListClient organizations={organizations} plans={plans} />;
}
