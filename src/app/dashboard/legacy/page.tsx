import "server-only";
import { redirect } from "next/navigation";
import { requireDashboardAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LegacySingleEventAdminPage() {
  await requireDashboardAuth();
  redirect("/dashboard");
}
