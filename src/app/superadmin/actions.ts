"use server";

import { revalidatePath } from "next/cache";
import {
  notifyCustomerOrganizationApproved,
  notifyCustomerOrganizationRejected,
} from "@/lib/notifications";
import { computePrice } from "@/lib/pricing";
import { getPricingAndPresets } from "@/lib/pricing-server";
import {
  ReviewPaymentActionSchema,
  ReviewPurchaseActionSchema,
  ReviewTopupActionSchema,
  SuperAdminApproveSignupRequestSchema,
  SuperAdminExtendExpirySchema,
  SuperAdminGrantPackageSchema,
  SuperAdminPaymentSettingsSchema,
  SuperAdminPricingConfigSchema,
  SuperAdminRejectSignupRequestSchema,
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
 * Accessible ONLY to users listed in `public.super_admins`.
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
          // Ignore if session already inactive
        }
      }
    } catch {
      // Non-fatal
    }
  }

  await admin.from("audit_log").insert({
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

  revalidatePath("/superadmin", "layout");
  revalidatePath("/pending");
  revalidatePath("/dashboard", "layout");
  revalidatePath("/e");
  return { success: true };
}

/**
 * Grants an immediate `active` package (`is_pilot` or manual) to an organization.
 * Accessible ONLY to users listed in `public.super_admins`.
 */
export async function superAdminGrantPackageAction(input: {
  orgId: string;
  planId?: string;
  eventsTotal: number;
  certsPerEvent: number;
  months: 3 | 6 | 12;
  isPilot?: boolean;
  note?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminGrantPackageSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", parsed.data.orgId)
    .maybeSingle();

  if (!orgRow) {
    return { error: "Organization not found." };
  }

  const { pricingConfig, presets } = await getPricingAndPresets();
  const matchedPreset = parsed.data.planId
    ? presets.find((p) => p.id === parsed.data.planId)
    : undefined;

  const eventsTotal = matchedPreset
    ? matchedPreset.eventsCount
    : parsed.data.eventsTotal;
  const certsPerEvent = matchedPreset
    ? matchedPreset.certsPerEvent
    : parsed.data.certsPerEvent;
  const months = matchedPreset ? matchedPreset.months : parsed.data.months;
  const kind = matchedPreset ? matchedPreset.kind : "custom";

  let listPricePkr = 0;
  let discountPkr = 0;
  let finalPricePkr = 0;
  try {
    const calc = computePrice(
      { events: eventsTotal, certsPerEvent, months },
      pricingConfig,
    );
    listPricePkr = calc.listPricePkr;
    discountPkr = parsed.data.isPilot ? calc.listPricePkr : calc.discountPkr;
    finalPricePkr = parsed.data.isPilot ? 0 : calc.finalPricePkr;
  } catch {
    const fallbackList =
      eventsTotal *
      (pricingConfig.eventFeePkr + pricingConfig.certRatePkr * certsPerEvent);
    listPricePkr = fallbackList;
    discountPkr = parsed.data.isPilot ? fallbackList : 0;
    finalPricePkr = parsed.data.isPilot ? 0 : fallbackList;
  }

  const now = new Date();
  const expires = new Date(now.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + months);

  const { data: created, error: insErr } = await admin
    .from("purchases")
    .insert({
      org_id: parsed.data.orgId,
      plan_id: matchedPreset ? matchedPreset.id : null,
      kind,
      events_total: eventsTotal,
      events_used: 0,
      certs_per_event: certsPerEvent,
      months,
      list_price_pkr: listPricePkr,
      discount_pkr: discountPkr,
      final_price_pkr: finalPricePkr,
      price_snapshot: {
        events: eventsTotal,
        certs_per_event: certsPerEvent,
        months,
        list_price_pkr: listPricePkr,
        discount_pkr: discountPkr,
        final_price_pkr: finalPricePkr,
        currency: "PKR",
      },
      is_pilot: parsed.data.isPilot,
      payment_method: parsed.data.isPilot ? "pilot" : "manual",
      payment_note: parsed.data.note || null,
      status: "active",
      starts_at: now.toISOString(),
      expires_at: expires.toISOString(),
      reviewed_by: superAdmin.email,
      reviewed_at: now.toISOString(),
    })
    .select("id, expires_at")
    .maybeSingle();

  if (insErr || !created) {
    return {
      error: sanitizeClientErrorMessage(insErr, "Failed to grant package."),
    };
  }

  await admin
    .from("organizations")
    .update({
      status: "active",
      rejection_reason: null,
      plan_id: matchedPreset ? matchedPreset.id : null,
      plan_expires_at: created.expires_at,
      plan_expiring_soon: false,
    })
    .eq("id", parsed.data.orgId);

  await admin.from("audit_log").insert({
    org_id: parsed.data.orgId,
    user_id: superAdmin.id,
    action: "superadmin.package_granted",
    details: {
      purchase_id: created.id,
      kind,
      events_total: eventsTotal,
      certs_per_event: certsPerEvent,
      months,
      is_pilot: parsed.data.isPilot,
      final_price_pkr: finalPricePkr,
      expires_at: created.expires_at,
      note: parsed.data.note || null,
      superadmin_email: superAdmin.email,
    },
  });

  revalidatePath("/superadmin", "layout");
  revalidatePath("/pending");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Extends expiry on an organization's active/latest purchase.
 */
export async function extendOrganizationExpiryAction(input: {
  orgId: string;
  purchaseId?: string;
  addDays?: number;
  exactDate?: string;
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

  let targetQuery = admin
    .from("purchases")
    .select("id, org_id, status, expires_at")
    .eq("org_id", parsed.data.orgId)
    .in("status", ["active", "expired"])
    .order("expires_at", { ascending: false })
    .limit(1);

  if (parsed.data.purchaseId) {
    targetQuery = admin
      .from("purchases")
      .select("id, org_id, status, expires_at")
      .eq("org_id", parsed.data.orgId)
      .eq("id", parsed.data.purchaseId)
      .limit(1);
  }

  const { data: purRows } = await targetQuery;
  const targetPurchase = purRows?.[0] as
    | { id: string; expires_at: string | null; status: string }
    | undefined;

  let newExpiresAt: string | null = null;
  if (parsed.data.exactDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.exactDate)) {
    newExpiresAt = `${parsed.data.exactDate}T23:59:59.999Z`;
  } else {
    const days = Math.min(3660, Math.max(1, Math.floor(parsed.data.addDays ?? 30)));
    newExpiresAt = computeExtendedExpiryIso(
      targetPurchase?.expires_at ?? null,
      days,
    );
  }

  if (targetPurchase) {
    await admin
      .from("purchases")
      .update({
        status: "active",
        expires_at: newExpiresAt,
      })
      .eq("id", targetPurchase.id)
      .eq("org_id", parsed.data.orgId);
  }

  const { error: updErr } = await admin
    .from("organizations")
    .update({
      plan_expires_at: newExpiresAt,
      plan_expiring_soon: false,
      expiry_flagged_at: null,
    })
    .eq("id", parsed.data.orgId);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to extend expiration.",
      ),
    };
  }

  await admin.from("audit_log").insert({
    org_id: parsed.data.orgId,
    user_id: superAdmin.id,
    action: "superadmin.expiry_extended",
    details: {
      purchase_id: targetPurchase?.id ?? null,
      previous_expires_at: targetPurchase?.expires_at ?? null,
      new_expires_at: newExpiresAt,
      add_days: parsed.data.addDays ?? null,
      exact_date: parsed.data.exactDate ?? null,
      reason: parsed.data.reason || null,
      superadmin_email: superAdmin.email,
    },
  });

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Approves or rejects a `pending` package purchase (`public.purchases`).
 */
export async function superAdminReviewPurchaseAction(input: {
  purchaseId: string;
  decision: "approved" | "rejected";
  note?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = ReviewPurchaseActionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: rpcRows, error } = await admin.rpc("review_purchase_request", {
    p_purchase_id: parsed.data.purchaseId,
    p_decision: parsed.data.decision,
    p_reviewer: superAdmin.email,
    p_note: parsed.data.note || null,
  });

  if (error) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Failed to review package purchase.",
      ),
    };
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { org_id?: string; expires_at?: string }
    | undefined;

  if (row?.org_id) {
    await admin.from("audit_log").insert({
      org_id: row.org_id,
      user_id: superAdmin.id,
      action:
        parsed.data.decision === "approved"
          ? "superadmin.purchase_approved"
          : "superadmin.purchase_rejected",
      details: {
        purchase_id: parsed.data.purchaseId,
        expires_at: row.expires_at ?? null,
        note: parsed.data.note || null,
        superadmin_email: superAdmin.email,
      },
    });
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/pending");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Approves or rejects a `pending` certificate top-up (`public.certificate_topups`).
 */
export async function superAdminReviewTopupAction(input: {
  topupId: string;
  decision: "approved" | "rejected";
  note?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = ReviewTopupActionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: rpcRows, error } = await admin.rpc("review_certificate_topup", {
    p_topup_id: parsed.data.topupId,
    p_decision: parsed.data.decision,
    p_reviewer: superAdmin.email,
    p_note: parsed.data.note || null,
  });

  if (error) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Failed to review certificate top-up.",
      ),
    };
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { org_id?: string; event_id?: string; new_max_certificates?: number }
    | undefined;

  if (row?.org_id) {
    await admin.from("audit_log").insert({
      org_id: row.org_id,
      user_id: superAdmin.id,
      action:
        parsed.data.decision === "approved"
          ? "superadmin.topup_approved"
          : "superadmin.topup_rejected",
      details: {
        topup_id: parsed.data.topupId,
        event_id: row.event_id ?? null,
        new_max_certificates: row.new_max_certificates ?? null,
        note: parsed.data.note || null,
        superadmin_email: superAdmin.email,
      },
    });
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Updates the single `public.pricing_config` row.
 */
export async function superAdminUpdatePricingConfigAction(input: {
  eventFeePkr: number;
  certRatePkr: number;
  roundingPkr: number;
  minEvents: number;
  maxEvents: number;
  minCertsPerEvent: number;
  maxCertsPerEvent: number;
  certsStep: number;
  volumeDiscounts: Array<{ min_events: number; discount: number }>;
  durationMultipliers: Array<{ months: number; mult: number }>;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: only super_admins can edit pricing_config.",
    };
  }

  const parsed = SuperAdminPricingConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const d = parsed.data;
  if (d.maxEvents < d.minEvents) {
    return { error: "maxEvents must be >= minEvents." };
  }
  if (d.maxCertsPerEvent < d.minCertsPerEvent) {
    return { error: "maxCertsPerEvent must be >= minCertsPerEvent." };
  }

  const allowedMonths = d.durationMultipliers.map((m) => m.months);
  const admin = getSupabaseAdmin();

  const { error: updErr } = await admin
    .from("pricing_config")
    .update({
      event_fee_pkr: d.eventFeePkr,
      cert_rate_pkr: d.certRatePkr,
      rounding_pkr: d.roundingPkr,
      min_events: d.minEvents,
      max_events: d.maxEvents,
      min_certs_per_event: d.minCertsPerEvent,
      max_certs_per_event: d.maxCertsPerEvent,
      certs_step: d.certsStep,
      volume_discounts: d.volumeDiscounts,
      duration_multipliers: d.durationMultipliers,
      allowed_months: allowedMonths,
      updated_by: superAdmin.id,
    })
    .eq("id", true);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to update pricing_config.",
      ),
    };
  }

  const { data: memRow } = await admin
    .from("organization_members")
    .select("org_id")
    .eq("user_id", superAdmin.id)
    .limit(1)
    .maybeSingle();

  if (memRow?.org_id) {
    await admin.from("audit_log").insert({
      org_id: memRow.org_id,
      user_id: superAdmin.id,
      action: "superadmin.pricing_config_updated",
      details: {
        event_fee_pkr: d.eventFeePkr,
        cert_rate_pkr: d.certRatePkr,
        rounding_pkr: d.roundingPkr,
        superadmin_email: superAdmin.email,
      },
    });
  }

  revalidatePath("/");
  revalidatePath("/signup");
  revalidatePath("/dashboard/billing");
  revalidatePath("/superadmin", "layout");
  return { success: true };
}

/**
 * Legacy payment_requests review compatibility action.
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

  const admin = getSupabaseAdmin();
  const { error } = await admin.rpc("review_payment_request", {
    p_request_id: parsed.data.requestId,
    p_decision: parsed.data.decision,
    p_reviewer: superAdmin.email,
    p_note: parsed.data.reviewerNote || null,
    p_billing_days: parsed.data.billingDays ?? 30,
  });

  if (error) {
    return {
      error: sanitizeClientErrorMessage(error, "Failed to review payment request."),
    };
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Approves a pending signup request in `/superadmin/requests`:
 * - `mode === "pilot"`: organization 'active', purchase 'active', `is_pilot = true`,
 *   discount = full price (`final_price_pkr = 0`), `starts_at = now`, `expires_at = now + months`.
 * - `mode === "paid"`: same with `is_pilot = false` and optional private `payment_note`.
 * Idempotent, writes to `audit_log`, and gated strictly by `public.super_admins`.
 */
export async function superAdminApproveSignupRequestAction(input: {
  orgId: string;
  purchaseId: string;
  mode: "pilot" | "paid";
  paymentNote?: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminApproveSignupRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();

  const { data: orgAndPur } = await admin
    .from("purchases")
    .select(
      "id, org_id, kind, events_total, certs_per_event, months, organizations!inner(id, name, contact_name, contact_email)",
    )
    .eq("id", parsed.data.purchaseId)
    .eq("org_id", parsed.data.orgId)
    .maybeSingle();

  if (!orgAndPur) {
    return { error: "Organization signup purchase request not found." };
  }

  const isPilot = parsed.data.mode === "pilot";
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "activate_purchase_and_organization",
    {
      p_purchase_id: parsed.data.purchaseId,
      p_is_pilot: isPilot,
      p_payment_note: parsed.data.paymentNote || null,
      p_actor_user_id: superAdmin.id,
      p_actor_label: superAdmin.email,
      p_payment_method: isPilot ? "pilot" : "manual",
    },
  );

  if (rpcErr) {
    return {
      error: sanitizeClientErrorMessage(
        rpcErr,
        "Failed to approve organization request.",
      ),
    };
  }

  const actRow = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | {
        already_processed?: boolean;
        expires_at?: string | null;
      }
    | undefined;

  if (!actRow?.already_processed) {
    const orgRel = Array.isArray(orgAndPur.organizations)
      ? (orgAndPur.organizations[0] as Record<string, unknown> | undefined)
      : (orgAndPur.organizations as Record<string, unknown> | undefined);
    const toEmail =
      typeof orgRel?.contact_email === "string" ? orgRel.contact_email : "";

    if (toEmail) {
      await notifyCustomerOrganizationApproved({
        toEmail,
        contactName:
          typeof orgRel?.contact_name === "string" ? orgRel.contact_name : "",
        orgName: String(orgRel?.name ?? ""),
        isPilot,
        planSummary: `${orgAndPur.events_total} event(s) × ${orgAndPur.certs_per_event} certs · ${orgAndPur.months} months`,
        expiresAt: actRow?.expires_at ?? null,
      });
    }
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/pending");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Rejects a pending signup request in `/superadmin/requests` with a required reason.
 * Sets organization `'rejected'`, marks pending purchase `'rejected'`, writes `audit_log`.
 * Idempotent and gated strictly by `public.super_admins`.
 */
export async function superAdminRejectSignupRequestAction(input: {
  orgId: string;
  purchaseId?: string;
  reason: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: your account is not listed in public.super_admins.",
    };
  }

  const parsed = SuperAdminRejectSignupRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const admin = getSupabaseAdmin();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, contact_name, contact_email")
    .eq("id", parsed.data.orgId)
    .maybeSingle();

  if (!orgRow) {
    return { error: "Organization not found." };
  }

  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "reject_organization_signup_request",
    {
      p_org_id: parsed.data.orgId,
      p_purchase_id: parsed.data.purchaseId ?? null,
      p_reason: parsed.data.reason,
      p_actor_user_id: superAdmin.id,
      p_actor_label: superAdmin.email,
    },
  );

  if (rpcErr) {
    return {
      error: sanitizeClientErrorMessage(
        rpcErr,
        "Failed to reject organization request.",
      ),
    };
  }

  const rejRow = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { already_processed?: boolean }
    | undefined;

  if (
    !rejRow?.already_processed &&
    typeof orgRow.contact_email === "string" &&
    orgRow.contact_email
  ) {
    await notifyCustomerOrganizationRejected({
      toEmail: orgRow.contact_email,
      contactName:
        typeof orgRow.contact_name === "string" ? orgRow.contact_name : "",
      orgName: String(orgRow.name ?? ""),
      reason: parsed.data.reason,
    });
  }

  revalidatePath("/superadmin", "layout");
  revalidatePath("/pending");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}

/**
 * Updates `public.payment_settings` (Bank / JazzCash / Easypaisa instructions).
 * Accessible ONLY to users listed in `public.super_admins`.
 */
export async function superAdminUpdatePaymentSettingsAction(input: {
  bankEnabled: boolean;
  bankName: string;
  bankAccountTitle: string;
  bankAccountNumber: string;
  bankIban: string;
  jazzcashEnabled: boolean;
  jazzcashAccountTitle: string;
  jazzcashNumber: string;
  easypaisaEnabled: boolean;
  easypaisaAccountTitle: string;
  easypaisaNumber: string;
  instructions: string;
}): Promise<SuperAdminActionResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error: "Forbidden: only super_admins can edit payment_settings.",
    };
  }

  const parsed = SuperAdminPaymentSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const d = parsed.data;
  const admin = getSupabaseAdmin();

  const { error: updErr } = await admin
    .from("payment_settings")
    .update({
      bank_enabled: d.bankEnabled,
      bank_name: d.bankName,
      bank_account_title: d.bankAccountTitle,
      bank_account_number: d.bankAccountNumber,
      bank_iban: d.bankIban,
      jazzcash_enabled: d.jazzcashEnabled,
      jazzcash_account_title: d.jazzcashAccountTitle,
      jazzcash_number: d.jazzcashNumber,
      easypaisa_enabled: d.easypaisaEnabled,
      easypaisa_account_title: d.easypaisaAccountTitle,
      easypaisa_number: d.easypaisaNumber,
      instructions: d.instructions,
      updated_by: superAdmin.id,
    })
    .eq("id", true);

  if (updErr) {
    return {
      error: sanitizeClientErrorMessage(
        updErr,
        "Failed to update payment settings.",
      ),
    };
  }

  const { data: memRow } = await admin
    .from("organization_members")
    .select("org_id")
    .eq("user_id", superAdmin.id)
    .limit(1)
    .maybeSingle();

  if (memRow?.org_id) {
    await admin.from("audit_log").insert({
      org_id: memRow.org_id,
      user_id: superAdmin.id,
      action: "superadmin.payment_settings_updated",
      details: {
        bank_enabled: d.bankEnabled,
        jazzcash_enabled: d.jazzcashEnabled,
        easypaisa_enabled: d.easypaisaEnabled,
        superadmin_email: superAdmin.email,
      },
    });
  }

  revalidatePath("/superadmin/payment-settings");
  revalidatePath("/dashboard/billing");
  return { success: true };
}
