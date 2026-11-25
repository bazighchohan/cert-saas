import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single generic error message for all lookup failures so attackers cannot
 * enumerate registered identifiers or names.
 */
export const GENERIC_LOOKUP_ERROR =
  "We couldn’t find a matching certificate record. Please double-check your details and try again.";

/**
 * Case- and space-insensitive normalization for attendee identifier & name matching.
 */
export function normalizeForLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function escapeIlikeExact(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Builds a header-safe PDF attachment filename.
 */
export function buildSafeCertificateFilename(
  eventSlug: string,
  certKey: string,
  identifier: string,
): string {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "cert";

  return `certificate-${clean(eventSlug)}-${clean(certKey)}-${clean(identifier)}.pdf`;
}

export interface LookupTokenPayload {
  orgId: string;
  eventId: string;
  slug: string;
  attendeeId: string;
  identifierLower: string;
  exp: number;
}

const LOOKUP_TOKEN_TTL_MS = 20 * 60 * 1000; // 20 minutes

export function signLookupTokenWithSecret(
  payload: Omit<LookupTokenPayload, "exp">,
  secret: string,
  ttlMs = LOOKUP_TOKEN_TTL_MS,
): string {
  const full: LookupTokenPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const bodyB64 = Buffer.from(JSON.stringify(full), "utf8").toString(
    "base64url",
  );
  const sigB64 = createHmac("sha256", secret)
    .update(bodyB64)
    .digest("base64url");
  return `${bodyB64}.${sigB64}`;
}

export function verifyLookupTokenWithSecret(
  token: string | null | undefined,
  secret: string,
): LookupTokenPayload | null {
  if (!token || typeof token !== "string" || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = createHmac("sha256", secret)
    .update(bodyB64)
    .digest("base64url");

  const a = Buffer.from(sigB64, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(bodyB64, "base64url").toString("utf8"),
    ) as LookupTokenPayload;
    if (!parsed.exp || parsed.exp <= Date.now()) return null;
    if (
      !parsed.orgId ||
      !parsed.eventId ||
      !parsed.slug ||
      !parsed.attendeeId ||
      !parsed.identifierLower
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
