import "server-only";

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import DashboardShell from "./DashboardShell";

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

  const org = await getCurrentOrg();
  if (!org) {
    redirect("/login?error=Could+not+load+your+organization");
  }

  return (
    <DashboardShell org={org} user={user}>
      {children}
    </DashboardShell>
  );
}
