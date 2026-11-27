import { randomUUID } from "node:crypto";
import type {
  CreateCheckoutInput,
  CreateCheckoutOutput,
  PaymentProvider,
  VerifyWebhookResult,
} from "./types";

/**
 * ManualProvider (active default while PAYMENT_GATEWAY_ENABLED=false):
 * - Keeps checkout inside the approval-gated manual/pilot flow (`/pending` or
 *   `/dashboard/billing`) without redirecting to any external gateway.
 * - Rejects external webhook calls since manual approvals go through `/superadmin/requests`.
 */
export class ManualProvider implements PaymentProvider {
  readonly name = "manual" as const;

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutOutput> {
    const providerRef = `manual_${input.purchaseId}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    return {
      checkoutUrl: input.returnUrl || "/pending",
      providerRef,
    };
  }

  async verifyWebhook(): Promise<VerifyWebhookResult> {
    return {
      valid: false,
      reason: "ManualProvider does not accept external payment webhooks.",
      event: null,
    };
  }
}
