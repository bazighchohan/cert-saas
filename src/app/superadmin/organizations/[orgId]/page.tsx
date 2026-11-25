import "server-only";

import { notFound } from "next/navigation";
import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getSuperAdminOrganizationDetailData } from "@/lib/superadmin-data";
import OrganizationDetailClient from "./OrganizationDetailClient";

export const dynamic = "force-dynamic";

export default async function SuperAdminOrganizationDetailPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const access = await checkSuperAdminPageAccess();
  if (!access.authorized) {
    return null;
  }

  const { orgId } = await params;
  const data = await getSuperAdminOrganizationDetailData(orgId);
  if (!data) {
    notFound();
  }

  return <OrganizationDetailClient data={data} />;
}
