import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  MAX_PAYMENT_PROOF_BYTES,
  validatePaymentProofBytes,
} from "@/lib/plan-enforcement-helpers";
import { computePrice } from "@/lib/pricing";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { PaymentUpgradeFieldsSchema } from "@/lib/schemas";
import { checkCsrfOrigin, formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * Compatibility endpoint that creates a `pending` row in `public.purchases`
 * using server-recomputed pricing from `computePrice` + `pricing_config`.
 */
export async function POST(req: NextRequest) {
  const csrf = checkCsrfOrigin(req);
  if (csrf) return csrf;

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PAYMENT_PROOF_BYTES + 256 * 1024
  ) {
    return NextResponse.json(
      { error: "Upload exceeds the 5 MB maximum size limit.", code: "PAYLOAD_TOO_LARGE" },
      { status: 413 },
    );
  }

  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json(
      { error: "You must be signed in to buy a package." },
      { status: 401 },
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

  const fieldsParsed = PaymentUpgradeFieldsSchema.safeParse({
    planId: String(formData.get("planId") ?? ""),
    paymentMethod: String(formData.get("paymentMethod") ?? "")
      .trim()
      .toLowerCase(),
    transactionReference: String(formData.get("transactionReference") ?? ""),
  });
  if (!fieldsParsed.success) {
    return NextResponse.json(
      { error: formatZodError(fieldsParsed.error), code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  const { planId, paymentMethod, transactionReference } = fieldsParsed.data;
  const screenshot = formData.get("screenshot");

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

  const { pricingConfig, presets } = await getPricingAndPresets();
  const preset = presets.find((p) => p.id === planId);
  if (!preset) {
    return NextResponse.json(
      { error: "Selected package preset is not available." },
      { status: 400 },
    );
  }

  const pricing = computePrice(
    {
      events: preset.eventsCount,
      certsPerEvent: preset.certsPerEvent,
      months: preset.months,
    },
    pricingConfig,
  );

  const admin = getSupabaseAdmin();
  await ensurePaymentProofsBucket();

  const objectPath = `${org.id}/purchase-${Date.now()}-${randomUUID().slice(0, 8)}.${validatedProof.extension}`;
  const { error: uploadErr } = await admin.storage
    .from("payment-proofs")
    .upload(objectPath, fileBytes, {
      contentType: validatedProof.mimeType,
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json(
      { error: "Failed to upload payment receipt screenshot. Please try again." },
      { status: 500 },
    );
  }

  const { data: created, error: insertErr } = await admin
    .from("purchases")
    .insert({
      org_id: org.id,
      requested_by: user.id,
      plan_id: preset.id,
      kind: preset.kind,
      events_total: preset.eventsCount,
      events_used: 0,
      certs_per_event: preset.certsPerEvent,
      months: preset.months,
      list_price_pkr: pricing.listPricePkr,
      discount_pkr: pricing.discountPkr,
      final_price_pkr: pricing.finalPricePkr,
      is_pilot: false,
      payment_method: paymentMethod,
      transaction_reference: transactionReference,
      screenshot_path: objectPath,
      status: "pending",
    })
    .select("id, status, created_at")
    .maybeSingle();

  if (insertErr || !created) {
    try {
      await admin.storage.from("payment-proofs").remove([objectPath]);
    } catch {
      // Ignore cleanup errors
    }
    return NextResponse.json(
      {
        error: sanitizeClientErrorMessage(
          insertErr,
          "Failed to record package purchase.",
        ),
      },
      { status: 500 },
    );
  }

  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard", "layout");

  return NextResponse.json({
    success: true,
    requestId: created.id as string,
    status: created.status as string,
  });
}
