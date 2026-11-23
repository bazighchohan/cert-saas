import "server-only";

import { cache } from "react";
import { requireDashboardAuth, type CurrentOrg, type CurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface PlanDetails {
  id: string;
  name: string;
  maxEvents: number | null;
  maxCertificatesPerEvent: number | null;
  maxCertificatesTotal: number | null;
  allowCustomBranding: boolean;
  pricePkr: number;
}

export interface OrgUsageSummary {
  org: CurrentOrg;
  user: CurrentUser;
  plan: PlanDetails;
  eventsUsed: number;
  certificatesUsed: number;
}

export interface EventSummaryRow {
  id: string;
  orgId: string;
  title: string;
  subtitle: string | null;
  slug: string;
  eventDate: string | null;
  released: boolean;
  identifierLabel: string;
  createdAt: string;
  attendeeCount: number;
}

const DEFAULT_FREE_PLAN: PlanDetails = {
  id: "free",
  name: "Free",
  maxEvents: 1,
  maxCertificatesPerEvent: 50,
  maxCertificatesTotal: 50,
  allowCustomBranding: false,
  pricePkr: 0,
};

/**
 * Loads the current organization's active plan details and current usage
 * (events count & issued certificates count), strictly scoped via getCurrentOrg().
 */
export const getOrgPlanAndUsage = cache(async (): Promise<OrgUsageSummary> => {
  const { user, org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const [planRes, eventsCountRes, certsCountRes] = await Promise.all([
    supabase
      .from("plans")
      .select(
        "id, name, max_events, max_certificates_per_event, max_certificates_total, allow_custom_branding, price_pkr",
      )
      .eq("id", org.planId)
      .maybeSingle(),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);

  const p = planRes.data;
  const plan: PlanDetails = p
    ? {
        id: p.id as string,
        name: p.name as string,
        maxEvents: (p.max_events as number | null) ?? null,
        maxCertificatesPerEvent:
          (p.max_certificates_per_event as number | null) ?? null,
        maxCertificatesTotal:
          (p.max_certificates_total as number | null) ?? null,
        allowCustomBranding: Boolean(p.allow_custom_branding),
        pricePkr: Number(p.price_pkr ?? 0),
      }
    : { ...DEFAULT_FREE_PLAN, id: org.planId };

  return {
    org,
    user,
    plan,
    eventsUsed: eventsCountRes.count ?? 0,
    certificatesUsed: certsCountRes.count ?? 0,
  };
});

/**
 * Lists all events belonging to the current organization (getCurrentOrg()).
 */
export const getOrgEvents = cache(async (): Promise<EventSummaryRow[]> => {
  const { org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("events")
    .select(
      "id, org_id, title, subtitle, slug, event_date, released, identifier_label, created_at, attendees(count)",
    )
    .eq("org_id", org.id)
    .order("created_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data.map((row) => {
    const attendeesRel = row.attendees as
      | Array<{ count?: number }>
      | { count?: number }
      | null;
    const attendeeCount = Array.isArray(attendeesRel)
      ? Number(attendeesRel[0]?.count ?? 0)
      : Number(attendeesRel?.count ?? 0);

    return {
      id: row.id as string,
      orgId: row.org_id as string,
      title: row.title as string,
      subtitle: (row.subtitle as string | null) ?? null,
      slug: row.slug as string,
      eventDate: (row.event_date as string | null) ?? null,
      released: Boolean(row.released),
      identifierLabel: (row.identifier_label as string) ?? "Registration number",
      createdAt: row.created_at as string,
      attendeeCount,
    };
  });
});

/**
 * Fetches a single event by id ONLY if it belongs to getCurrentOrg().
 * Returns null if the event does not exist or belongs to another organization.
 */
export async function getOrgEventById(
  eventId: string,
): Promise<EventSummaryRow | null> {
  const { org } = await requireDashboardAuth();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, org_id, title, subtitle, slug, event_date, released, identifier_label, created_at, attendees(count)",
    )
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const attendeesRel = data.attendees as
    | Array<{ count?: number }>
    | { count?: number }
    | null;
  const attendeeCount = Array.isArray(attendeesRel)
    ? Number(attendeesRel[0]?.count ?? 0)
    : Number(attendeesRel?.count ?? 0);

  return {
    id: data.id as string,
    orgId: data.org_id as string,
    title: data.title as string,
    subtitle: (data.subtitle as string | null) ?? null,
    slug: data.slug as string,
    eventDate: (data.event_date as string | null) ?? null,
    released: Boolean(data.released),
    identifierLabel: (data.identifier_label as string) ?? "Registration number",
    createdAt: data.created_at as string,
    attendeeCount,
  };
}
