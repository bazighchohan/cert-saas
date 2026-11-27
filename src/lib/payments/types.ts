export type PaymentRecordStatus = "created" | "paid" | "failed" | "refunded";
export type PaymentProviderName = "manual" | "safepay";

export interface PaymentCustomer {
  name: string;
  email: string;
  phone?: string;
  orgId?: string;
  orgName?: string;
}

export interface CreateCheckoutInput {
  purchaseId: string;
  amount: number;
  currency: string;
  customer: PaymentCustomer;
  returnUrl: string;
}

export interface CreateCheckoutOutput {
  checkoutUrl: string;
  providerRef: string;
}

export interface VerifiedWebhookEvent {
  provider: PaymentProviderName;
  providerRef: string;
  purchaseId: string | null;
  status: PaymentRecordStatus;
  amount: number;
  currency: string;
  timestamp: number;
  raw: Record<string, unknown>;
}

export interface VerifyWebhookResult {
  valid: boolean;
  reason?: string;
  event: VerifiedWebhookEvent | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutOutput>;
  verifyWebhook(
    rawBody: string,
    headers: Headers | Record<string, string | undefined>,
  ): Promise<VerifyWebhookResult>;
}
