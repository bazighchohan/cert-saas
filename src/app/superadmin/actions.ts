"use server";

import { revalidatePath } from "next/cache";
import {
  ReviewPaymentActionSchema,
  SuperAdminChangePlanSchema,
  SuperAdminExtendExpirySchema,
  SuperAdminSuspendSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getCurrentSuperAdmin } from "@/lib/superadmin";
import { computeExtendedExpiryIso } from "@/lib/superadmin-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

export interface SuperAdminActionResult {
  success?: boolean;
  error?: string;
}

/**
 * Suspends or unsuspends an organization.
 * - Accessible ONLY to users listed in `public.super_admins`.
 * - When suspending: sets `organizations.status = 'suspended'`, revokes active
 *   refresh tokens for all organization members (unless that member is also a
 *   platform super_admin), and immediately blocks both admin login/dashboard
 *   and public `/e/[slug]` pages.
 * - Writes `superadmin.org_suspended` or `superadmin.org_unsuspended` to `audit_log`.
 */
export async function setOrganizationSuspendedAction(input: {
  orgId: string;
  suspended: boolean;
  reason?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminSuspendSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, slug, status")
    .eq("id", parsed.data.orgId)
    .maybeSingle();

  if (!orgRow) {
    return { error: "Organization not found." };
  }

  const targetStatus = parsed.data.suspended ? "suspended" : "active";

  const { error: updErr } = await admin
    .from("organizations")
    .update({ status: targetStatus })
    .eq("id", parsed.data.orgId);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to update organization status.",
      ),
    };
  }

  // If suspending, also revoke Supabase refresh sessions for non-superadmin members
  if (input.suspended) {
    try {
      const [{ data: members }, { data: allSupers }] = await Promise.all([
        admin
          .from("organization_members")
          .select("user_id")
          .eq("org_id", input.orgId),
        admin.from("super_admins").select("user_id"),
      ]);

      const superSet = new Set(
        (allSupers ?? []).map((s) => String(s.user_id)),
      );
      for (const m of members ?? []) {
        const uid = String(m.user_id);
        if (superSet.has(uid)) continue;
        try {
          await admin.auth.admin.signOut(uid, "global");
        } catch {
          // Ignore if session already inactive or GoTrue admin signOut unsupported
        }
      }
    } catch {
      // Non-fatal: RLS + getCurrentOrg + layout redirect already enforce instant block
    }
  }

  const { error: auditErr } = await admin.from("audit_log").insert({
    org_id: input.orgId,
    user_id: superAdmin.id,
    action: input.suspended
      ? "superadmin.org_suspended"
      : "superadmin.org_unsuspended",
    details: {
      previous_status: orgRow.status,
      new_status: targetStatus,
      reason: input.reason?.trim() || null,
      superadmin_email: superAdmin.email,
    },
  });

  if (auditErr) {
    console.error("[superadmin] audit_log write failed:", auditErr);
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  revalidatePath(`/e`);
  return { success: true };
}

/**
 * Manually changes an organization's plan (`free`, `starter`, `pro`, etc.)
 * and updates `plan_expires_at`. Writes `superadmin.plan_changed` to `audit_log`.
 */
export async function changeOrganizationPlanManuallyAction(input: {
  orgId: string;
  planId: string;
  durationDays?: number | null;
  reason?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminChangePlanSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const cleanPlanId = parsed.data.planId;
  const admin = getSupabaseAdmin();

  const [orgRes, planRes] = await Promise.all([
    admin
      .from("organizations")
      .select("id, name, plan_id, plan_expires_at")
      .eq("id", input.orgId)
      .maybeSingle(),
    admin
      .from("plans")
      .select("id, name, price_pkr")
      .eq("id", cleanPlanId)
      .maybeSingle(),
  ]);

  if (!orgRes.data) {
    return { error: "Organization not found." };
  }
  if (!planRes.data) {
    return { error: `Plan "${cleanPlanId}" does not exist.` };
  }

  let nextExpiresAt: string | null = null;
  if (cleanPlanId !== "free") {
    const days = Math.min(
      3660,
      Math.max(1, Math.floor(input.durationDays ?? 30)),
    );
    nextExpiresAt = computeExtendedExpiryIso(null, days);
  } else if (input.durationDays && input.durationDays > 0) {
    nextExpiresAt = computeExtendedExpiryIso(null, input.durationDays);
  }

  const { error: updErr } = await admin
    .from("organizations")
    .update({
      plan_id: cleanPlanId,
      plan_expires_at: nextExpiresAt,
      plan_expiring_soon: false,
      expiry_flagged_at: null,
    })
    .eq("id", input.orgId);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to change organization plan.",
      ),
    };
  }

  const { error: auditErr } = await admin.from("audit_log").insert({
    org_id: input.orgId,
    user_id: superAdmin.id,
    action: "superadmin.plan_changed",
    details: {
      previous_plan_id: orgRes.data.plan_id,
      new_plan_id: cleanPlanId,
      previous_expires_at: orgRes.data.plan_expires_at,
      new_expires_at: nextExpiresAt,
      reason: input.reason?.trim() || null,
      superadmin_email: superAdmin.email,
    },
  });

  if (auditErr) {
    console.error("[superadmin] audit_log write failed:", auditErr);
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Extends (or sets an exact date for) an organization's `plan_expires_at`.
 * Writes `superadmin.expiry_extended` to `audit_log`.
 */
export async function extendOrganizationExpiryAction(input: {
  orgId: string;
  addDays?: number;
  exactDate?: string; // YYYY-MM-DD
  clearExpiry?: boolean;
  reason?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminExtendExpirySchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, plan_id, plan_expires_at")
    .eq("id", parsed.data.orgId)
    .maybeSingle();

  if (!orgRow) {
    return { error: "Organization not found." };
  }

  let newExpiresAt: string | null = null;
  if (input.clearExpiry) {
    newExpiresAt = null;
  } else if (input.exactDate && /^\d{4}-\d{2}-\d{2}$/.test(input.exactDate.trim())) {
    newExpiresAt = `${input.exactDate.trim()}T23:59:59.999Z`;
  } else {
    const days = Math.min(3660, Math.max(1, Math.floor(input.addDays ?? 30)));
    newExpiresAt = computeExtendedExpiryIso(
      typeof orgRow.plan_expires_at === "string" ? orgRow.plan_expires_at : null,
      days,
    );
  }

  const { error: updErr } = await admin
    .from("organizations")
    .update({
      plan_expires_at: newExpiresAt,
      plan_expiring_soon: false,
      expiry_flagged_at: null,
    })
    .eq("id", input.orgId);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to extend plan expiration.",
      ),
    };
  }

  const { error: auditErr } = await admin.from("audit_log").insert({
    org_id: input.orgId,
    user_id: superAdmin.id,
    action: "superadmin.expiry_extended",
    details: {
      plan_id: orgRow.plan_id,
      previous_expires_at: orgRow.plan_expires_at,
      new_expires_at: newExpiresAt,
      add_days: input.addDays ?? null,
      exact_date: input.exactDate ?? null,
      reason: input.reason?.trim() || null,
      superadmin_email: superAdmin.email,
    },
  });

  if (auditErr) {
    console.error("[superadmin] audit_log write failed:", auditErr);
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Approves or rejects a pending `payment_requests` row from `/superadmin/payments`
 * or `/superadmin/organizations/[orgId]`.
 * Writes both `billing.plan_upgraded` / `billing.payment_rejected` (via DB trigger)
 * AND `superadmin.payment_approved` / `superadmin.payment_rejected` (with `user_id = superAdmin.id`).
 */
export async function superAdminReviewPaymentAction(input: {
  requestId: string;
  decision: "approved" | "rejected";
  reviewerNote?: string;
  billingDays?: number;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = ReviewPaymentActionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const billingDays = parsed.data.billingDays ?? 30;
  const admin = getSupabaseAdmin();

  const { data: rpcRows, error } = await admin.rpc("review_payment_request", {
    p_request_id: parsed.data.requestId,
    p_decision: parsed.data.decision,
    p_reviewer: superAdmin.email,
    p_note: parsed.data.reviewerNote || null,
    p_billing_days: billingDays,
  });

  if (error) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Failed to process payment review.",
      ),
    };
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { org_id?: string; plan_id?: string; plan_expires_at?: string }
    | undefined;

  if (row?.org_id) {
    await admin.from("audit_log").insert({
      org_id: row.org_id,
      user_id: superAdmin.id,
      action:
        input.decision === "approved"
          ? "superadmin.payment_approved"
          : "superadmin.payment_rejected",
      details: {
        payment_request_id: input.requestId,
        plan_id: row.plan_id ?? null,
        billing_days: billingDays,
        plan_expires_at: row.plan_expires_at ?? null,
        reviewer_note: input.reviewerNote?.trim() || null,
        superadmin_email: superAdmin.email,
      },
    });
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}
