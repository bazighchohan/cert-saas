"use server";

import { revalidatePath } from "next/cache";
import { ReviewPaymentActionSchema } from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getCurrentSuperAdmin } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";

export interface ReviewPaymentResult {
  success?: boolean;
  error?: string;
}

/**
 * Platform super-admin action to approve or reject a pending `payment_requests` row.
 * Gated strictly by membership in `public.super_admins` (never via env password).
 */
export async function reviewPaymentRequestAction(input: {
  requestId: string;
  decision: "approved" | "rejected";
  reviewerNote?: string;
  billingDays?: number;
}): Promise<ReviewPaymentResult> {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return {
      error:
        "Unauthorized: only users listed in public.super_admins can review payment requests.",
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
        "Failed to process payment request review.",
      ),
    };
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { org_id?: string; plan_id?: string }
    | undefined;

  if (row?.org_id) {
    try {
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
          reviewer_note: input.reviewerNote?.trim() || null,
        },
      });
    } catch {
      // Non-fatal if audit_log already recorded by trigger
    }
  }

  revalidatePath("/dashboard/billing");
  revalidatePath("/superadmin", "layout");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}
