import "server-only";

import {
  evaluatePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  normalizePlanResource,
  PlanEnforcementError,
  type OrgPlanStateSnapshot,
  type PlanErrorCode,
  type PlanQuotaLimits,
  type PlanResourceInput,
} from "@/lib/plan-enforcement-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

export {
  evaluatePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  PlanEnforcementError,
  type PlanErrorCode,
  type PlanQuotaLimits,
  type PlanResourceInput,
};

const FALLBACK_FREE_QUOTAS: PlanQuotaLimits = {
  id: "free",
  name: "Free",
  maxEvents: 1,
  maxCertificatesPerEvent: 50,
  maxCertificatesTotal: 50,
  maxCertificateTypesPerEvent: 3,
};

/**
 * Central server-side plan & expiration enforcement guard.
 * Used by every create, import, and dashboard mutation route.
 *
 * - Blocks suspended organizations (`ORG_SUSPENDED`).
 * - Blocks expired plans (`PLAN_EXPIRED` -> read-only mode: admins can view & export,
 *   and public downloads keep working, while mutations are blocked).
 * - Blocks quota overages (`PLAN_LIMIT_REACHED`) for `event`, `certificate_type`,
 *   `attendee`, `certificate`, and `import`.
 *
 * Throws `PlanEnforcementError` when blocked; resolves with the org's `PlanQuotaLimits` when allowed.
 */
export async function assertWithinPlan(
  orgId: string,
  resource: PlanResourceInput,
): Promise<PlanQuotaLimits> {
  const admin = getSupabaseAdmin();
  const normalized = normalizePlanResource(resource);

  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("*")
    .eq("id", orgId)
    .maybeSingle();

  if (orgErr || !orgRow) {
    throw new PlanEnforcementError(
      "ORG_SUSPENDED",
      "Organization not found.",
      404,
    );
  }

  const rawOrg = orgRow as Record<string, unknown>;
  const planId = (rawOrg.plan_id as string) || "free";
  const orgStatus = ((rawOrg.status as string) === "suspended"
    ? "suspended"
    : "active") as "active" | "suspended";
  const planExpiresAt =
    typeof rawOrg.plan_expires_at === "string" ? rawOrg.plan_expires_at : null;

  const { data: planData } = await admin
    .from("plans")
    .select("*")
    .eq("id", planId)
    .maybeSingle();

  const p = planData as Record<string, unknown> | null;
  const plan: PlanQuotaLimits = p
    ? {
        id: p.id as string,
        name: (p.name as string) || planId,
        maxEvents: (p.max_events as number | null) ?? null,
        maxCertificatesPerEvent:
          (p.max_certificates_per_event as number | null) ?? null,
        maxCertificatesTotal:
          (p.max_certificates_total as number | null) ?? null,
        maxCertificateTypesPerEvent:
          p.max_certificate_types_per_event === undefined
            ? null
            : ((p.max_certificate_types_per_event as number | null) ?? null),
      }
    : { ...FALLBACK_FREE_QUOTAS, id: planId };

  // Check suspended + expired first before running count queries if only checking "write"
  if (normalized.kind === "write") {
    evaluatePlanEnforcement({ orgStatus, planExpiresAt, plan }, resource);
    return plan;
  }

  const snapshot: OrgPlanStateSnapshot = {
    orgStatus,
    planExpiresAt,
    plan,
  };

  if (normalized.kind === "event") {
    const { count } = await admin
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
    snapshot.eventsUsed = count ?? 0;
  } else if (normalized.kind === "certificate_type") {
    const { count } = await admin
      .from("certificate_types")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("event_id", normalized.eventId!);
    snapshot.eventTypesUsed = count ?? 0;
  } else {
    const [attRes, evCertsRes, orgCertsRes] = await Promise.all([
      admin
        .from("attendees")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("event_id", normalized.eventId!),
      admin
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("event_id", normalized.eventId!),
      admin
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId),
    ]);
    snapshot.eventAttendeesUsed = attRes.count ?? 0;
    snapshot.eventCertificatesUsed = evCertsRes.count ?? 0;
    snapshot.totalCertificatesUsed = orgCertsRes.count ?? 0;
  }

  evaluatePlanEnforcement(snapshot, resource);
  return plan;
}
