import "server-only";

import { requireDashboardAuth } from "@/lib/auth";
import { getReleased } from "@/lib/supabase";
import ReleaseToggle from "@/app/admin/ReleaseToggle";
import AdminContentWrapper from "@/app/admin/AdminContentWrapper";

export const dynamic = "force-dynamic";

/**
 * Preserves the legacy single-event attendee tools until they are mounted
 * inside per-event pages (/dashboard/events/[eventId]) in the next phase.
 */
export default async function LegacySingleEventAdminPage() {
  await requireDashboardAuth();

  let released = false;
  try {
    released = await getReleased();
  } catch {
    released = false;
  }

  return (
    <div className="space-y-8">
      <ReleaseToggle initialReleased={released} />
      <AdminContentWrapper />
    </div>
  );
}
