import { isPaymentGatewayEnabled } from "@/lib/feature-flags";
import { ManualProvider } from "./manual-provider";
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  SafepayProvider,
  signSafepayWebhookPayload,
} from "./safepay-provider";
import type { PaymentProvider, VerifyWebhookResult } from "./types";

export * from "./types";
export {
  ManualProvider,
  SafepayProvider,
  signSafepayWebhookPayload,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
};

type EnvLike = Record<string, string | undefined>;

/**
 * Returns the active PaymentProvider:
 * - `ManualProvider` when `PAYMENT_GATEWAY_ENABLED` is `false` (default)
 * - `SafepayProvider` when `PAYMENT_GATEWAY_ENABLED` is `true`
 */
export function getPaymentProvider(env: EnvLike = process.env): PaymentProvider {
  if (isPaymentGatewayEnabled(env)) {
    return new SafepayProvider({ env });
  }
  return new ManualProvider();
}

export interface WebhookRpcResultRow {
  ok: boolean;
  code: string;
  http_status: number;
  already_processed: boolean;
  org_id: string | null;
  purchase_id: string | null;
}

export interface HandlePaymentWebhookOutcome {
  httpStatus: number;
  body: {
    received?: boolean;
    alreadyProcessed?: boolean;
    code: string;
    error?: string;
    purchaseId?: string | null;
  };
}

/**
 * Pure, testable Safepay webhook orchestrator used by `POST /api/webhooks/safepay`.
 * 1. Rejects when `PAYMENT_GATEWAY_ENABLED=false` (unless `allowWhenGatewayDisabled` is passed in unit tests).
 * 2. Verifies HMAC-SHA256 signature on `rawBody` with `timingSafeEqual` and rejects stale timestamps.
 * 3. Delegates atomic lookup by `provider_ref`, `price_snapshot` amount comparison, idempotency,
 *    and purchase+org activation to `processWebhookInDb`.
 */
export async function handleSafepayWebhookPayload(params: {
  rawBody: string;
  headers: Headers | Record<string, string | undefined>;
  env?: EnvLike;
  nowMs?: () => number;
  allowWhenGatewayDisabled?: boolean;
  processWebhookInDb: (args: {
    provider: "safepay";
    providerRef: string;
    eventStatus: "paid" | "failed" | "refunded";
    webhookAmount: number;
    webhookCurrency: string;
    rawEvent: Record<string, unknown>;
  }) => Promise<WebhookRpcResultRow>;
}): Promise<HandlePaymentWebhookOutcome> {
  const env = params.env ?? process.env;

  if (!params.allowWhenGatewayDisabled && !isPaymentGatewayEnabled(env)) {
    return {
      httpStatus: 503,
      body: {
        code: "GATEWAY_DISABLED",
        error: "Payment gateway webhooks are currently disabled.",
      },
    };
  }

  const provider = new SafepayProvider({
    env,
    nowMs: params.nowMs,
  });

  const verified: VerifyWebhookResult = await provider.verifyWebhook(
    params.rawBody,
    params.headers,
  );

  if (!verified.valid || !verified.event) {
    const reason = verified.reason || "Invalid webhook signature.";
    const code = reason.toLowerCase().includes("stale")
      ? "STALE_TIMESTAMP"
      : "INVALID_SIGNATURE";
    return {
      httpStatus: 401,
      body: {
        code,
        error: reason,
      },
    };
  }

  const ev = verified.event;
  if (ev.status === "created") {
    return {
      httpStatus: 200,
      body: {
        received: true,
        alreadyProcessed: false,
        code: "IGNORED_CREATED",
      },
    };
  }

  const rpcRow = await params.processWebhookInDb({
    provider: "safepay",
    providerRef: ev.providerRef,
    eventStatus: ev.status,
    webhookAmount: ev.amount,
    webhookCurrency: ev.currency,
    rawEvent: ev.raw,
  });

  if (!rpcRow.ok) {
    return {
      httpStatus: rpcRow.http_status || 400,
      body: {
        code: rpcRow.code || "WEBHOOK_REJECTED",
        error:
          rpcRow.code === "AMOUNT_MISMATCH"
            ? "Webhook amount or currency does not match stored purchase price_snapshot."
            : rpcRow.code === "PAYMENT_NOT_FOUND"
              ? "Unknown payment provider_ref."
              : "Webhook could not be processed.",
        purchaseId: rpcRow.purchase_id,
      },
    };
  }

  return {
    httpStatus: 200,
    body: {
      received: true,
      alreadyProcessed: Boolean(rpcRow.already_processed),
      code: rpcRow.code,
      purchaseId: rpcRow.purchase_id,
    },
  };
}
