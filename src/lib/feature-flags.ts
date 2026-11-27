export interface PlatformFeatureFlags {
  requirePaymentProof: boolean;
  emailsEnabled: boolean;
  paymentGatewayEnabled: boolean;
}

type EnvLike = Record<string, string | undefined>;

function parseBooleanFlag(raw: string | undefined, defaultValue = false): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return defaultValue;
}

/**
 * REQUIRE_PAYMENT_PROOF (default: false)
 * When true, package & top-up requests require payment method, transaction ID,
 * and receipt screenshot upload, and expose Bank/JazzCash/Easypaisa details.
 */
export function isPaymentProofRequired(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.REQUIRE_PAYMENT_PROOF, false);
}

/**
 * EMAILS_ENABLED (default: false)
 * When true, sends Resend emails (RESEND_API_KEY, EMAIL_FROM, SUPER_ADMIN_EMAIL)
 * on new signup requests, approvals, and rejections. Failures are logged and never block.
 */
export function areEmailsEnabled(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.EMAILS_ENABLED, false);
}

/**
 * PAYMENT_GATEWAY_ENABLED (default: false)
 * When false, ManualProvider is active and external gateway checkout/webhooks stay switched off.
 */
export function isPaymentGatewayEnabled(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.PAYMENT_GATEWAY_ENABLED, false);
}

export function getFeatureFlags(env: EnvLike = process.env): PlatformFeatureFlags {
  return {
    requirePaymentProof: isPaymentProofRequired(env),
    emailsEnabled: areEmailsEnabled(env),
    paymentGatewayEnabled: isPaymentGatewayEnabled(env),
  };
}
