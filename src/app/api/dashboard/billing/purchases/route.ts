import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  MAX_PAYMENT_PROOF_BYTES,
  validatePaymentProofBytes,
} from "@/lib/plan-enforcement-helpers";
import {
  computePrice,
  validatePricingInput,
  type PackageKind,
} from "@/lib/pricing";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { PurchaseRequestFieldsSchema } from "@/lib/schemas";
import {
  checkCsrfOrigin,
  formatZodError,
  sanitizeClientErrorMessage,
} from "@/lib/security";
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
 * POST /api/dashboard/billing/purchases
 * Creates a `pending` package purchase row in `public.purchases`.
 * Always recomputes `list_price_pkr`, `discount_pkr`, and `final_price_pkr`
 * on the server from `public.pricing_config` + `computePrice()` — never trusts
 * any amount sent by the client.
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
      {
        error: "Upload exceeds the 5 MB maximum size limit.",
        code: "PAYLOAD_TOO_LARGE",
      },
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

  const parsedFields = PurchaseRequestFieldsSchema.safeParse({
    selectionType: String(formData.get("selectionType") ?? "preset"),
    planId: formData.get("planId") ? String(formData.get("planId")) : "",
    events: formData.get("events") ?? undefined,
    certsPerEvent: formData.get("certsPerEvent") ?? undefined,
    months: formData.get("months") ?? undefined,
    paymentMethod: String(formData.get("paymentMethod") ?? "")
      .trim()
      .toLowerCase(),
    transactionReference: String(formData.get("transactionReference") ?? ""),
    paymentNote: String(formData.get("paymentNote") ?? ""),
  });

  if (!parsedFields.success) {
    return NextResponse.json(
      { error: formatZodError(parsedFields.error), code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  const {
    selectionType,
    planId,
    events: rawEvents,
    certsPerEvent: rawCerts,
    months: rawMonths,
    paymentMethod,
    transactionReference,
    paymentNote,
  } = parsedFields.data;

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

  let resolvedPlanId: string | null = null;
  let kind: PackageKind = "custom";
  let eventsTotal: number;
  let certsPerEvent: number;
  let months: number;

  if (selectionType === "preset") {
    const preset = presets.find((p) => p.id === planId);
    if (!preset) {
      return NextResponse.json(
        { error: "Selected package preset does not exist." },
        { status: 400 },
      );
    }
    resolvedPlanId = preset.id;
    kind = preset.kind;
    eventsTotal = preset.eventsCount;
    certsPerEvent = preset.certsPerEvent;
    months = preset.months;
  } else {
    const check = validatePricingInput(
      {
        events: Number(rawEvents),
        certsPerEvent: Number(rawCerts),
        months: Number(rawMonths ?? 3),
      },
      pricingConfig,
    );
    if (!check.valid) {
      return NextResponse.json(
        { error: check.error, code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    resolvedPlanId = null;
    kind = "custom";
    eventsTotal = check.normalized.events;
    certsPerEvent = check.normalized.certsPerEvent;
    months = check.normalized.months;
  }

  // Server-side authoritative price computation (never trusts client amounts)
  const priceBreakdown = computePrice(
    { events: eventsTotal, certsPerEvent, months },
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
    console.error("[billing:purchases:upload] storage error:", uploadErr);
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
      plan_id: resolvedPlanId,
      kind,
      events_total: eventsTotal,
      events_used: 0,
      certs_per_event: certsPerEvent,
      months,
      list_price_pkr: priceBreakdown.listPricePkr,
      discount_pkr: priceBreakdown.discountPkr,
      final_price_pkr: priceBreakdown.finalPricePkr,
      is_pilot: false,
      payment_method: paymentMethod,
      transaction_reference: transactionReference,
      screenshot_path: objectPath,
      payment_note: paymentNote || null,
      status: "pending",
    })
    .select("id, status, final_price_pkr, created_at")
    .maybeSingle();

  if (insertErr || !created) {
    try {
      await admin.storage.from("payment-proofs").remove([objectPath]);
    } catch {
      // Ignore cleanup error
    }
    console.error("[billing:purchases:insert] DB error:", insertErr);
    return NextResponse.json(
      {
        error: sanitizeClientErrorMessage(
          insertErr,
          "Failed to record package purchase request.",
        ),
      },
      { status: 500 },
    );
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "billing.purchase_requested",
      details: {
        purchase_id: created.id,
        plan_id: resolvedPlanId,
        kind,
        events_total: eventsTotal,
        certs_per_event: certsPerEvent,
        months,
        list_price_pkr: priceBreakdown.listPricePkr,
        discount_pkr: priceBreakdown.discountPkr,
        final_price_pkr: priceBreakdown.finalPricePkr,
        payment_method: paymentMethod,
        transaction_reference: transactionReference,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for purchase_requested:", err);
  }

  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard", "layout");
  revalidatePath("/superadmin", "layout");

  return NextResponse.json({
    success: true,
    purchaseId: created.id as string,
    status: created.status as string,
    finalPricePkr: priceBreakdown.finalPricePkr,
  });
}
