import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isPaymentGatewayEnabled } from "@/lib/feature-flags";
import type {
  CreateCheckoutInput,
  CreateCheckoutOutput,
  PaymentProvider,
  PaymentRecordStatus,
  VerifyWebhookResult,
} from "./types";

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

type EnvLike = Record<string, string | undefined>;
type FetchLike = typeof fetch;

function getHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(name);
    return val ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Computes the canonical Safepay HMAC-SHA256 hex digest over `${timestampSec}.${rawBody}`.
 * Binding the timestamp to the raw body prevents replay attacks with forged timestamps.
 */
export function signSafepayWebhookPayload(
  rawBody: string,
  timestampSec: number | string,
  webhookSecret: string,
): string {
  return createHmac("sha256", webhookSecret)
    .update(`${timestampSec}.${rawBody}`, "utf8")
    .digest("hex");
}

function constantTimeHexEquals(expectedHex: string, receivedRaw: string): boolean {
  const cleaned = receivedRaw.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), "hex");
  const receivedBuf = Buffer.from(cleaned, "hex");
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, receivedBuf);
}

function normalizeSafepayStatus(rawStatus: unknown): PaymentRecordStatus | null {
  const s = String(rawStatus ?? "")
    .trim()
    .toLowerCase();
  if (s === "paid" || s === "succeeded" || s === "completed" || s === "payment.succeeded") {
    return "paid";
  }
  if (s === "failed" || s === "payment.failed" || s === "cancelled") {
    return "failed";
  }
  if (s === "refunded" || s === "payment.refunded") {
    return "refunded";
  }
  if (s === "created" || s === "pending") {
    return "created";
  }
  return null;
}

/**
 * SafepayProvider (stubbed HTTP client with real cryptographic webhook verification).
 * Disabled by default (`PAYMENT_GATEWAY_ENABLED=false`).
 *
 * Environment variables when enabled:
 * - `SAFEPAY_API_KEY`        (public/merchant API key)
 * - `SAFEPAY_SECRET_KEY`     (server API secret key)
 * - `SAFEPAY_WEBHOOK_SECRET` (HMAC signing secret for `/api/webhooks/safepay`)
 * - `SAFEPAY_BASE_URL`       (defaults to `https://sandbox.api.getsafepay.com`)
 */
export class SafepayProvider implements PaymentProvider {
  readonly name = "safepay" as const;
  private readonly env: EnvLike;
  private readonly fetchImpl: FetchLike;
  private readonly nowMsFn: () => number;
  private readonly maxSkewSeconds: number;

  constructor(options?: {
    env?: EnvLike;
    fetchImpl?: FetchLike;
    nowMs?: () => number;
    maxSkewSeconds?: number;
  }) {
    this.env = options?.env ?? process.env;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.nowMsFn = options?.nowMs ?? (() => Date.now());
    this.maxSkewSeconds =
      options?.maxSkewSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  }

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutOutput> {
    if (!isPaymentGatewayEnabled(this.env)) {
      throw new Error(
        "Safepay checkout is disabled because PAYMENT_GATEWAY_ENABLED is false.",
      );
    }

    const apiKey = this.env.SAFEPAY_API_KEY?.trim();
    const secretKey = this.env.SAFEPAY_SECRET_KEY?.trim();
    const baseUrl = (
      this.env.SAFEPAY_BASE_URL?.trim() || "https://sandbox.api.getsafepay.com"
    ).replace(/\/+$/, "");

    if (!apiKey || !secretKey) {
      throw new Error(
        "SAFEPAY_API_KEY and SAFEPAY_SECRET_KEY must be configured before creating a Safepay checkout session.",
      );
    }

    // TODO(safepay-live): Replace stub endpoint path/payload with Safepay's live
    // Order Init + Hosted Checkout Session API:
    //   1. POST `${baseUrl}/order/v1/init` with `{ client: apiKey, amount: input.amount, currency: input.currency, environment: "sandbox" | "production" }`
    //      to obtain `data.token` (the `track_...` providerRef).
    //   2. POST `${baseUrl}/reporter/api/v1/payments` or build the hosted checkout URL
    //      with `beacon=${token}`, `order_id=${input.purchaseId}`, `redirect_url=${input.returnUrl}`,
    //      and `cancel_url=${input.returnUrl}`.
    const response = await this.fetchImpl(`${baseUrl}/order/v1/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SFPY-MERCHANT-SECRET": secretKey,
      },
      body: JSON.stringify({
        client: apiKey,
        amount: input.amount,
        currency: input.currency,
        order_id: input.purchaseId,
        customer: {
          name: input.customer.name,
          email: input.customer.email,
          phone: input.customer.phone ?? "",
        },
        return_url: input.returnUrl,
      }),
    });

    if (!response.ok) {
      throw new Error(`Safepay checkout initialization failed (HTTP ${response.status}).`);
    }

    const payload = (await response.json()) as {
      data?: { token?: string; checkout_url?: string };
      token?: string;
      checkoutUrl?: string;
    };

    const providerRef =
      payload.data?.token ||
      payload.token ||
      `sfpy_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // TODO(safepay-live): Use Safepay's official hosted checkout host (`https://sandbox.api.getsafepay.com/components` or production checkout URL).
    const checkoutUrl =
      payload.data?.checkout_url ||
      payload.checkoutUrl ||
      `${baseUrl}/checkout/pay?tracker=${encodeURIComponent(providerRef)}&redirect_url=${encodeURIComponent(input.returnUrl)}`;

    return {
      checkoutUrl,
      providerRef,
    };
  }

  async verifyWebhook(
    rawBody: string,
    headers: Headers | Record<string, string | undefined>,
  ): Promise<VerifyWebhookResult> {
    const webhookSecret = this.env.SAFEPAY_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      return {
        valid: false,
        reason: "SAFEPAY_WEBHOOK_SECRET is not configured.",
        event: null,
      };
    }

    if (typeof rawBody !== "string" || rawBody.length === 0) {
      return {
        valid: false,
        reason: "Empty webhook payload.",
        event: null,
      };
    }

    const signatureHeader =
      getHeader(headers, "x-sfpy-signature") ??
      getHeader(headers, "x-safepay-signature");
    const timestampHeader =
      getHeader(headers, "x-sfpy-timestamp") ??
      getHeader(headers, "x-safepay-timestamp");

    if (!signatureHeader || !timestampHeader) {
      return {
        valid: false,
        reason: "Missing Safepay webhook signature or timestamp header.",
        event: null,
      };
    }

    const timestampSec = Number(timestampHeader.trim());
    if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
      return {
        valid: false,
        reason: "Invalid webhook timestamp header.",
        event: null,
      };
    }

    const nowSec = Math.floor(this.nowMsFn() / 1000);
    if (Math.abs(nowSec - timestampSec) > this.maxSkewSeconds) {
      return {
        valid: false,
        reason: "Stale webhook timestamp rejected.",
        event: null,
      };
    }

    const expectedHex = signSafepayWebhookPayload(
      rawBody,
      timestampSec,
      webhookSecret,
    );

    if (!constantTimeHexEquals(expectedHex, signatureHeader)) {
      return {
        valid: false,
        reason: "Invalid webhook HMAC signature.",
        event: null,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(rawBody);
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return {
          valid: false,
          reason: "Webhook body must be a JSON object.",
          event: null,
        };
      }
      parsed = json as Record<string, unknown>;
    } catch {
      return {
        valid: false,
        reason: "Malformed JSON in webhook payload.",
        event: null,
      };
    }

    const dataObj =
      parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? (parsed.data as Record<string, unknown>)
        : parsed;

    const providerRef = String(
      dataObj.tracker ??
        dataObj.provider_ref ??
        dataObj.providerRef ??
        parsed.provider_ref ??
        "",
    ).trim();

    if (!providerRef) {
      return {
        valid: false,
        reason: "Missing provider_ref / tracker in webhook payload.",
        event: null,
      };
    }

    const status = normalizeSafepayStatus(
      dataObj.status ?? dataObj.state ?? parsed.type ?? parsed.status,
    );
    if (!status) {
      return {
        valid: false,
        reason: "Unrecognized payment status in webhook payload.",
        event: null,
      };
    }

    const rawAmount = Number(dataObj.amount ?? parsed.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0 || !Number.isInteger(rawAmount)) {
      return {
        valid: false,
        reason: "Invalid integer payment amount in webhook payload.",
        event: null,
      };
    }

    const currency = String(dataObj.currency ?? parsed.currency ?? "PKR")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return {
        valid: false,
        reason: "Invalid 3-letter currency code in webhook payload.",
        event: null,
      };
    }

    const purchaseIdRaw =
      dataObj.order_id ??
      dataObj.purchase_id ??
      dataObj.purchaseId ??
      parsed.purchase_id;

    return {
      valid: true,
      event: {
        provider: "safepay",
        providerRef,
        purchaseId:
          typeof purchaseIdRaw === "string" && purchaseIdRaw.trim()
            ? purchaseIdRaw.trim()
            : null,
        status,
        amount: rawAmount,
        currency,
        timestamp: timestampSec,
        raw: parsed,
      },
    };
  }
}
