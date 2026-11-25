import "server-only";

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import {
  getCurrentOrgResult,
  getCurrentUser,
  resolveOrganizationName,
} from "@/lib/auth";
import DashboardShell from "./DashboardShell";
import ProvisionOrgErrorCard from "./ProvisionOrgErrorCard";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const { org, error } = await getCurrentOrgResult();
  if (!org) {
    const defaultOrgName = resolveOrganizationName({
      explicitName: user.orgNameFromMeta,
      userMetadata: user.userMetadata,
      email: user.email,
    });

    return (
      <ProvisionOrgErrorCard
        userEmail={user.email}
        defaultOrgName={defaultOrgName}
        initialError={
          error ||
          "Could not automatically create or load your organization. Click Retry below."
        }
      />
    );
  }

  if (org.status !== "active") {
    redirect("/account-suspended");
  }

  return (
    <DashboardShell org={org} user={user}>
      {children}
    </DashboardShell>
  );
}
