export interface PlatformFeatureFlags {
  requirePaymentProof: boolean;
  emailsEnabled: boolean;
  paymentGatewayEnabled: boolean;
  pilotBannerEnabled: boolean;
  analyticsEnabled: boolean;
}

export interface CookieFreeAnalyticsConfig {
  enabled: boolean;
  scriptSrc: string | null;
  domain: string | null;
}

type EnvLike = Record<string, string | undefined>;

function parseBooleanFlag(
  raw: string | undefined,
  defaultValue = false,
): boolean {
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
 */
export function isPaymentProofRequired(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.REQUIRE_PAYMENT_PROOF, false);
}

/**
 * EMAILS_ENABLED (default: false)
 */
export function areEmailsEnabled(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.EMAILS_ENABLED, false);
}

/**
 * PAYMENT_GATEWAY_ENABLED (default: false)
 */
export function isPaymentGatewayEnabled(env: EnvLike = process.env): boolean {
  return parseBooleanFlag(env.PAYMENT_GATEWAY_ENABLED, false);
}

/**
 * PILOT_BANNER_ENABLED (default: true during pilot)
 * Controls the pricing banner: "Pilot: approved by our team, no payment needed yet"
 */
export function isPilotBannerEnabled(env: EnvLike = process.env): boolean {
  const raw = env.PILOT_BANNER_ENABLED ?? env.NEXT_PUBLIC_PILOT_BANNER_ENABLED;
  return parseBooleanFlag(raw, true);
}

/**
 * ANALYTICS_ENABLED (default: false)
 * Enables optional cookie-free analytics (e.g. Plausible / Umami) without cookies or PII.
 */
export function isAnalyticsEnabled(env: EnvLike = process.env): boolean {
  const raw = env.ANALYTICS_ENABLED ?? env.NEXT_PUBLIC_ANALYTICS_ENABLED;
  return parseBooleanFlag(raw, false);
}

export function getCookieFreeAnalyticsConfig(
  env: EnvLike = process.env,
): CookieFreeAnalyticsConfig {
  const enabled = isAnalyticsEnabled(env);
  if (!enabled) {
    return { enabled: false, scriptSrc: null, domain: null };
  }
  const scriptSrc =
    env.NEXT_PUBLIC_ANALYTICS_SRC?.trim() ||
    "https://plausible.io/js/script.js";
  const domain = env.NEXT_PUBLIC_ANALYTICS_DOMAIN?.trim() || null;
  return {
    enabled: Boolean(scriptSrc && domain),
    scriptSrc,
    domain,
  };
}

export function getSupportWhatsappInfo(env: EnvLike = process.env): {
  displayNumber: string;
  href: string;
} {
  const raw =
    env.NEXT_PUBLIC_SUPPORT_WHATSAPP?.trim() || "+92 300 1234567";
  const digits = raw.replace(/[^0-9]/g, "");
  const normalized = digits.startsWith("0")
    ? `92${digits.slice(1)}`
    : digits || "923001234567";
  return {
    displayNumber: raw,
    href: `https://wa.me/${normalized}?text=${encodeURIComponent(
      "Hi! I have a question about issuing e-certificates on CertSaaS.",
    )}`,
  };
}

export function getFeatureFlags(env: EnvLike = process.env): PlatformFeatureFlags {
  return {
    requirePaymentProof: isPaymentProofRequired(env),
    emailsEnabled: areEmailsEnabled(env),
    paymentGatewayEnabled: isPaymentGatewayEnabled(env),
    pilotBannerEnabled: isPilotBannerEnabled(env),
    analyticsEnabled: isAnalyticsEnabled(env),
  };
}
