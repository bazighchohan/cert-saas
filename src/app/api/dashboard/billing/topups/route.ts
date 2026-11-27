import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isPaymentProofRequired } from "@/lib/feature-flags";
import {
  MAX_PAYMENT_PROOF_BYTES,
  validatePaymentProofBytes,
} from "@/lib/plan-enforcement-helpers";
import { computeTopupPrice } from "@/lib/pricing";
import { getPricingConfig } from "@/lib/pricing-server";
import {
  CertificateTopupFieldsSchema,
  CertificateTopupNoProofFieldsSchema,
} from "@/lib/schemas";
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
 * POST /api/dashboard/billing/topups
 * Creates a `pending` certificate top-up request for an existing event owned
 * by `getCurrentOrg()`. Respects `REQUIRE_PAYMENT_PROOF` and always recomputes
 * `amount_pkr = certs_added * cert_rate_pkr` on the server from `public.pricing_config`.
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
  if (!user) {
    return NextResponse.json(
      {
        error: "You must be signed in to request a certificate top-up.",
        code: "UNAUTHORIZED",
      },
      { status: 401 },
    );
  }

  const org = await getCurrentOrg();
  if (!org) {
    return NextResponse.json(
      {
        error: "Your organization is pending approval.",
        code: "ORG_NOT_ACTIVE",
        redirectTo: "/pending",
      },
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

  const requireProof = isPaymentProofRequired();
  let eventId: string;
  let certsAdded: number;
  let paymentMethod: "bank" | "jazzcash" | "easypaisa" | "manual" = "manual";
  let transactionReference: string | null = null;
  let paymentNote = "";

  if (requireProof) {
    const parsedFields = CertificateTopupFieldsSchema.safeParse({
      eventId: String(formData.get("eventId") ?? ""),
      certsAdded: formData.get("certsAdded") ?? 0,
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

    eventId = parsedFields.data.eventId;
    certsAdded = parsedFields.data.certsAdded;
    paymentMethod = parsedFields.data.paymentMethod;
    transactionReference = parsedFields.data.transactionReference;
    paymentNote = parsedFields.data.paymentNote;
  } else {
    const parsedFields = CertificateTopupNoProofFieldsSchema.safeParse({
      eventId: String(formData.get("eventId") ?? ""),
      certsAdded: formData.get("certsAdded") ?? 0,
      paymentNote: String(formData.get("paymentNote") ?? ""),
    });

    if (!parsedFields.success) {
      return NextResponse.json(
        { error: formatZodError(parsedFields.error), code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    eventId = parsedFields.data.eventId;
    certsAdded = parsedFields.data.certsAdded;
    paymentMethod = "manual";
    transactionReference = null;
    paymentNote = parsedFields.data.paymentNote;
  }

  const admin = getSupabaseAdmin();

  const { data: eventRow, error: evErr } = await admin
    .from("events")
    .select("id, org_id, title, max_certificates")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (evErr || !eventRow) {
    return NextResponse.json(
      { error: "Event not found for your organization." },
      { status: 404 },
    );
  }

  const pricingConfig = await getPricingConfig();
  let topupCalc: { certsAdded: number; certRatePkr: number; amountPkr: number };
  try {
    topupCalc = computeTopupPrice(certsAdded, pricingConfig);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Invalid certificate top-up quantity.",
        code: "VALIDATION_ERROR",
      },
      { status: 400 },
    );
  }

  let objectPath: string | null = null;
  const screenshot = formData.get("screenshot");
  if (requireProof) {
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
    await ensurePaymentProofsBucket();
    objectPath = `${org.id}/topup-${Date.now()}-${randomUUID().slice(0, 8)}.${validatedProof.extension}`;
    const { error: uploadErr } = await admin.storage
      .from("payment-proofs")
      .upload(objectPath, fileBytes, {
        contentType: validatedProof.mimeType,
        upsert: false,
      });

    if (uploadErr) {
      console.error("[billing:topups:upload] storage error:", uploadErr);
      return NextResponse.json(
        {
          error: "Failed to upload payment receipt screenshot. Please try again.",
        },
        { status: 500 },
      );
    }
  } else if (screenshot instanceof File && screenshot.size > 0) {
    const fileBytes = new Uint8Array(await screenshot.arrayBuffer());
    const validatedProof = validatePaymentProofBytes(fileBytes, screenshot.type);
    if (!validatedProof.valid) {
      return NextResponse.json({ error: validatedProof.error }, { status: 400 });
    }
    await ensurePaymentProofsBucket();
    objectPath = `${org.id}/topup-${Date.now()}-${randomUUID().slice(0, 8)}.${validatedProof.extension}`;
    await admin.storage.from("payment-proofs").upload(objectPath, fileBytes, {
      contentType: validatedProof.mimeType,
      upsert: false,
    });
  }

  const { data: created, error: insertErr } = await admin
    .from("certificate_topups")
    .insert({
      org_id: org.id,
      event_id: eventId,
      requested_by: user.id,
      certs_added: topupCalc.certsAdded,
      cert_rate_pkr: topupCalc.certRatePkr,
      amount_pkr: topupCalc.amountPkr,
      payment_method: paymentMethod,
      transaction_reference: transactionReference,
      screenshot_path: objectPath,
      payment_note: paymentNote || null,
      status: "pending",
    })
    .select("id, status, amount_pkr, created_at")
    .maybeSingle();

  if (insertErr || !created) {
    if (objectPath) {
      try {
        await admin.storage.from("payment-proofs").remove([objectPath]);
      } catch {
        // Ignore cleanup error
      }
    }
    console.error("[billing:topups:insert] DB error:", insertErr);
    return NextResponse.json(
      {
        error: sanitizeClientErrorMessage(
          insertErr,
          "Failed to record certificate top-up request.",
        ),
      },
      { status: 500 },
    );
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "billing.topup_requested",
      details: {
        topup_id: created.id,
        event_id: eventId,
        event_title: eventRow.title,
        certs_added: topupCalc.certsAdded,
        cert_rate_pkr: topupCalc.certRatePkr,
        amount_pkr: topupCalc.amountPkr,
        payment_method: paymentMethod,
        transaction_reference: transactionReference,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for topup_requested:", err);
  }

  revalidatePath("/dashboard/billing");
  revalidatePath(`/dashboard/events/${eventId}`);
  revalidatePath("/superadmin", "layout");

  return NextResponse.json({
    success: true,
    topupId: created.id as string,
    status: created.status as string,
    amountPkr: topupCalc.amountPkr,
  });
}
