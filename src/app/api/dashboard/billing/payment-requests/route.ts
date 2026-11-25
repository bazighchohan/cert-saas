import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  MAX_PAYMENT_PROOF_BYTES,
  validatePaymentProofBytes,
} from "@/lib/plan-enforcement-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const ALLOWED_METHODS = new Set(["bank", "jazzcash", "easypaisa"]);

async function ensurePaymentProofsBucket() {
  const admin = getSupabaseAdmin();
  const { data: bucket } = await admin.storage.getBucket("payment-proofs");
  if (!bucket) {
    await admin.storage.createBucket("payment-proofs", {
      public: false,
      fileSizeLimit: MAX_PAYMENT_PROOF_BYTES,
      allowedMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "application/pdf",
      ],
    });
  }
}

/**
 * POST /api/dashboard/billing/payment-requests
 * Creates a manual upgrade `payment_requests` row (status: 'pending') with an
 * uploaded payment screenshot stored under `payment-proofs/{org_id}/...`.
 *
 * Allowed even when the organization's current plan is expired (read-only mode),
 * since submitting an upgrade/renewal request is how an expired org renews!
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json(
      { error: "You must be signed in to request an upgrade." },
      { status: 401 },
    );
  }

  if (org.status !== "active") {
    return NextResponse.json(
      { error: "Your organization is suspended. Contact support." },
      { status: 403 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data." },
      { status: 400 },
    );
  }

  const planId = String(formData.get("planId") ?? "").trim().toLowerCase();
  const paymentMethod = String(formData.get("paymentMethod") ?? "")
    .trim()
    .toLowerCase();
  const transactionReference = String(
    formData.get("transactionReference") ?? "",
  ).trim();
  const screenshot = formData.get("screenshot");

  if (!planId) {
    return NextResponse.json(
      { error: "Please select a plan to upgrade to." },
      { status: 400 },
    );
  }

  if (!ALLOWED_METHODS.has(paymentMethod)) {
    return NextResponse.json(
      {
        error:
          "Payment method must be Bank Transfer, JazzCash, or Easypaisa.",
      },
      { status: 400 },
    );
  }

  if (transactionReference.length < 2 || transactionReference.length > 120) {
    return NextResponse.json(
      {
        error:
          "Transaction reference / TID must be between 2 and 120 characters.",
      },
      { status: 400 },
    );
  }

  if (!(screenshot instanceof File) || screenshot.size === 0) {
    return NextResponse.json(
      {
        error:
          "Please attach a payment receipt screenshot (PNG, JPG, WebP, or PDF, max 5 MB).",
      },
      { status: 400 },
    );
  }

  const fileBytes = new Uint8Array(await screenshot.arrayBuffer());
  const validatedProof = validatePaymentProofBytes(fileBytes, screenshot.type);
  if (!validatedProof.valid) {
    return NextResponse.json({ error: validatedProof.error }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Look up target plan server-side so amount_pkr can never be spoofed by the client
  const { data: planRow, error: planErr } = await admin
    .from("plans")
    .select("id, name, price_pkr, active")
    .eq("id", planId)
    .maybeSingle();

  if (planErr || !planRow || !planRow.active) {
    return NextResponse.json(
      { error: "Selected plan is not available." },
      { status: 400 },
    );
  }

  const amountPkr = Number(planRow.price_pkr ?? 0);
  if (amountPkr <= 0) {
    return NextResponse.json(
      { error: "Only paid plans require a payment upgrade request." },
      { status: 400 },
    );
  }

  await ensurePaymentProofsBucket();

  const objectPath = `${org.id}/${Date.now()}-${randomUUID().slice(0, 8)}.${validatedProof.extension}`;
  const { error: uploadErr } = await admin.storage
    .from("payment-proofs")
    .upload(objectPath, fileBytes, {
      contentType: validatedProof.mimeType,
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json(
      { error: `Failed to upload payment screenshot: ${uploadErr.message}` },
      { status: 500 },
    );
  }

  const { data: created, error: insertErr } = await admin
    .from("payment_requests")
    .insert({
      org_id: org.id,
      requested_by: user.id,
      plan_id: planRow.id as string,
      amount_pkr: amountPkr,
      payment_method: paymentMethod,
      transaction_reference: transactionReference,
      screenshot_path: objectPath,
      status: "pending",
      billing_days: 30,
    })
    .select("id, status, created_at")
    .maybeSingle();

  if (insertErr || !created) {
    // Clean up uploaded object if DB insert failed
    try {
      await admin.storage.from("payment-proofs").remove([objectPath]);
    } catch {
      // Ignore cleanup errors
    }
    return NextResponse.json(
      {
        error:
          insertErr?.message ||
          "Failed to record payment request. Ensure migration 011_billing_and_plan_enforcement.sql has been applied.",
      },
      { status: 500 },
    );
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "billing.upgrade_requested",
      details: {
        payment_request_id: created.id,
        plan_id: planRow.id,
        plan_name: planRow.name,
        amount_pkr: amountPkr,
        payment_method: paymentMethod,
        transaction_reference: transactionReference,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for upgrade_requested:", err);
  }

  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard", "layout");

  return NextResponse.json({
    success: true,
    requestId: created.id as string,
    status: created.status as string,
  });
}
