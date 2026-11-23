import "server-only";

import { notFound } from "next/navigation";
import { getOrgEvents, getOrgPlanAndUsage } from "@/lib/dashboard-data";
import EventsListClient from "./EventsListClient";

export const dynamic = "force-dynamic";

export default async function DashboardEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ orgId?: string; org?: string }>;
}) {
  const [usage, events, params] = await Promise.all([
    getOrgPlanAndUsage(),
    getOrgEvents(),
    searchParams,
  ]);

  // Tenant isolation guard: if a URL explicitly asks for another org's id or slug, reject it.
  if (
    (params.orgId && params.orgId !== usage.org.id) ||
    (params.org && params.org !== usage.org.slug)
  ) {
    notFound();
  }

  return (
    <EventsListClient
      events={events}
      eventsUsed={usage.eventsUsed}
      maxEvents={usage.plan.maxEvents}
      planName={usage.plan.name}
    />
  );
}
