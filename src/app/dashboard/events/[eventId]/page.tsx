import "server-only";

import { notFound } from "next/navigation";
import { getOrgEventById } from "@/lib/dashboard-data";
import EventWorkspaceClient, { type EventTab } from "./EventWorkspaceClient";

export const dynamic = "force-dynamic";

const VALID_TABS = new Set<EventTab>([
  "overview",
  "template",
  "attendees",
  "downloads",
  "settings",
]);

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);

  // Strictly scoped to getCurrentOrg(): returns null if the event belongs to another org.
  const event = await getOrgEventById(eventId);
  if (!event) {
    notFound();
  }

  const initialTab =
    query.tab && VALID_TABS.has(query.tab as EventTab)
      ? (query.tab as EventTab)
      : "overview";

  return <EventWorkspaceClient event={event} initialTab={initialTab} />;
}
