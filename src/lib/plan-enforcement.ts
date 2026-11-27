import "server-only";

import {
  evaluatePurchasePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  PlanEnforcementError,
  sortActiveUnexpiredPurchases,
  type EventEnforcementSnapshot,
  type OrgPurchaseEnforcementState,
  type PlanActionInput,
  type PlanAllowanceResult,
  type PlanErrorCode,
  type PurchaseStatus,
  type PurchaseSummarySnapshot,
} from "@/lib/plan-enforcement-helpers";
import type { PackageKind } from "@/lib/pricing";
import { getSupabaseAdmin } from "@/lib/supabase";

export {
  evaluatePurchasePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  PlanEnforcementError,
  sortActiveUnexpiredPurchases,
  type EventEnforcementSnapshot,
  type OrgPurchaseEnforcementState,
  type PlanActionInput,
  type PlanAllowanceResult,
  type PlanErrorCode,
  type PurchaseStatus,
  type PurchaseSummarySnapshot,
};

export function mapPurchaseSummaryRow(
  row: Record<string, unknown>,
): PurchaseSummarySnapshot {
  const rawKind = String(row.kind ?? "custom");
  const kind: PackageKind = (
    ["single", "multi", "pro", "custom"] as const
  ).includes(rawKind as PackageKind)
    ? (rawKind as PackageKind)
    : "custom";

  const rawStatus = String(row.status ?? "pending");
  const status: PurchaseStatus = (
    ["pending", "active", "rejected", "expired"] as const
  ).includes(rawStatus as PurchaseStatus)
    ? (rawStatus as PurchaseStatus)
    : "pending";

  return {
    id: String(row.id),
    orgId: String(row.org_id),
    planId: typeof row.plan_id === "string" ? row.plan_id : null,
    kind,
    eventsTotal: Math.max(1, Number(row.events_total ?? 1)),
    eventsUsed: Math.max(0, Number(row.events_used ?? 0)),
    certsPerEvent: Math.max(1, Number(row.certs_per_event ?? 50)),
    months: Number(row.months ?? 3),
    status,
    isPilot: Boolean(row.is_pilot),
    startsAt: typeof row.starts_at === "string" ? row.starts_at : null,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

/**
 * Central server-side package & per-event certificate limit guard:
 *   `assertWithinPlan(orgId, eventId, action)`
 *
 * Used by event creation, event release, template mutations, manual attendee
 * additions, CSV/Excel imports, and certificate-type assignments.
 *
 * - Blocks suspended organizations (`ORG_SUSPENDED`).
 * - Blocks organizations without an approved active purchase (`NO_ACTIVE_PURCHASE`,
 *   `PURCHASE_PENDING`, `NO_EVENT_SLOTS`, `PURCHASE_EXPIRED`).
 * - Enforces each event's own `events.max_certificates` (`PLAN_LIMIT_REACHED`).
 */
export async function assertWithinPlan(
  orgId: string,
  eventId: string | null,
  action: PlanActionInput,
): Promise<PlanAllowanceResult> {
  const admin = getSupabaseAdmin();

  const [orgRes, purchasesRes] = await Promise.all([
    admin
      .from("organizations")
      .select("id, status")
      .eq("id", orgId)
      .maybeSingle(),
    admin
      .from("purchases")
      .select("*")
      .eq("org_id", orgId)
      .order("expires_at", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (orgRes.error || !orgRes.data) {
    throw new PlanEnforcementError(
      "ORG_SUSPENDED",
      "Organization not found.",
      404,
    );
  }

  const orgStatus =
    (orgRes.data as Record<string, unknown>).status === "suspended"
      ? "suspended"
      : "active";

  const purchases = ((purchasesRes.data ?? []) as Array<Record<string, unknown>>).map(
    mapPurchaseSummaryRow,
  );

  let eventSnapshot: EventEnforcementSnapshot | null = null;

  if (eventId) {
    const { data: evRow, error: evErr } = await admin
      .from("events")
      .select("id, org_id, purchase_id, max_certificates")
      .eq("id", eventId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (!evErr && evRow) {
      const rawEv = evRow as Record<string, unknown>;
      const needsCounts =
        typeof action === "object" &&
        (action.kind === "attendee" ||
          action.kind === "certificate" ||
          action.kind === "import" ||
          action.kind === "certificate_type");

      let attendeesUsed = 0;
      let certificatesUsed = 0;
      let certificateTypesUsed = 0;

      if (needsCounts) {
        if (action.kind === "certificate_type") {
          const { count } = await admin
            .from("certificate_types")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("event_id", eventId);
          certificateTypesUsed = count ?? 0;
        } else {
          const [attCountRes, certCountRes] = await Promise.all([
            admin
              .from("attendees")
              .select("id", { count: "exact", head: true })
              .eq("org_id", orgId)
              .eq("event_id", eventId),
            admin
              .from("attendee_certificates")
              .select("id", { count: "exact", head: true })
              .eq("org_id", orgId)
              .eq("event_id", eventId),
          ]);
          attendeesUsed = attCountRes.count ?? 0;
          certificatesUsed = certCountRes.count ?? 0;
        }
      }

      eventSnapshot = {
        id: String(rawEv.id),
        orgId: String(rawEv.org_id),
        purchaseId:
          typeof rawEv.purchase_id === "string" ? rawEv.purchase_id : null,
        maxCertificates: Math.max(1, Number(rawEv.max_certificates ?? 50)),
        attendeesUsed,
        certificatesUsed,
        certificateTypesUsed,
        maxCertificateTypes: 20,
      };
    }
  }

  return evaluatePurchasePlanEnforcement({
    orgId,
    orgStatus,
    purchases,
    event: eventSnapshot,
  }, eventId, action);
}
