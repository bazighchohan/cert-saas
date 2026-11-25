"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/dashboard-data";
import { getSupabaseAdmin } from "@/lib/supabase";

export interface ReviewPaymentResult {
  success?: boolean;
  error?: string;
}

/**
 * Platform super-admin action to approve or reject a pending `payment_requests` row.
 * Gated by `SUPER_ADMIN_EMAILS`. Calls `review_payment_request` RPC so approving
 * atomically upgrades `organizations.plan_id`, extends `plan_expires_at`, and
 * writes `billing.plan_upgraded` to `audit_log`.
 */
export async function reviewPaymentRequestAction(input: {
  requestId: string;
  decision: "approved" | "rejected";
  reviewerNote?: string;
  billingDays?: number;
}): Promise<ReviewPaymentResult> {
  const user = await getCurrentUser();
  if (!user || !isSuperAdminEmail(user.email)) {
    return {
      error:
        "Unauthorized: only platform super-admins (configured in SUPER_ADMIN_EMAILS) can review payment requests.",
    };
  }

  if (input.decision !== "approved" && input.decision !== "rejected") {
    return { error: "Decision must be approved or rejected." };
  }

  const billingDays = Math.min(
    3660,
    Math.max(1, Math.floor(input.billingDays ?? 30)),
  );
  const admin = getSupabaseAdmin();

  const { error } = await admin.rpc("review_payment_request", {
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_reviewer: user.email,
    p_note: input.reviewerNote?.trim() || null,
    p_billing_days: billingDays,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard", "layout");
  return { success: true };
}
