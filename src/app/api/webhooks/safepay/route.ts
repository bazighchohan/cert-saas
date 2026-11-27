import "server-only";

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import {
  handleSafepayWebhookPayload,
  type WebhookRpcResultRow,
} from "@/lib/payments";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = 256 * 1024; // 256 KB

/**
 * POST /api/webhooks/safepay
 * Disabled by default (`PAYMENT_GATEWAY_ENABLED=false` -> 503).
 * When enabled:
 * - Reads the exact raw body (never re-serialized) and verifies the HMAC-SHA256
 *   signature with `crypto.timingSafeEqual` + rejects stale timestamps.
 * - Looks up `public.payments` by unique `provider_ref` inside a Postgres transaction.
 * - Verifies webhook amount & currency match the stored `purchases.price_snapshot`.
 * - Activates the purchase & organization idempotently via `activate_purchase_and_organization`.
 */
export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json(
      { error: "Webhook payload too large.", code: "PAYLOAD_TOO_LARGE" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { error: "Failed to read webhook body.", code: "BAD_BODY" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
    return NextResponse.json(
      { error: "Webhook payload too large.", code: "PAYLOAD_TOO_LARGE" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  const outcome = await handleSafepayWebhookPayload({
    rawBody,
    headers: req.headers,
    async processWebhookInDb(args) {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin.rpc("process_payment_webhook", {
        p_provider: args.provider,
        p_provider_ref: args.providerRef,
        p_event_status: args.eventStatus,
        p_webhook_amount: args.webhookAmount,
        p_webhook_currency: args.webhookCurrency,
        p_raw_event: args.rawEvent,
      });

      if (error || !data) {
        console.error("[webhooks:safepay] RPC error:", error);
        return {
          ok: false,
          code: "DB_ERROR",
          http_status: 500,
          already_processed: false,
          org_id: null,
          purchase_id: null,
        };
      }

      const row = (Array.isArray(data) ? data[0] : data) as
        | WebhookRpcResultRow
        | undefined;

      if (!row) {
        return {
          ok: false,
          code: "DB_ERROR",
          http_status: 500,
          already_processed: false,
          org_id: null,
          purchase_id: null,
        };
      }

      if (row.ok && !row.already_processed) {
        revalidatePath("/pending");
        revalidatePath("/dashboard", "layout");
        revalidatePath("/superadmin", "layout");
      }

      return row;
    },
  });

  return NextResponse.json(outcome.body, {
    status: outcome.httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}
