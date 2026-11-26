/**
 * Pure, framework-agnostic security helpers (unit-testable without Next.js server runtime).
 */

export const MAX_JSON_BODY_BYTES_DEFAULT = 64 * 1024; // 64 KB default for standard JSON endpoints
export const MAX_IMPORT_JSON_BODY_BYTES = 8 * 1024 * 1024; // 8 MB max for up-to-5,000-row tabular import JSON
export const MAX_SIGNED_URL_TTL_SECONDS = 60; // Hard cap: signed Storage URLs expire in <= 60s

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Verifies CSRF protection for cookie-authenticated state-changing HTTP requests
 * by checking `Origin` (or `Referer` fallback) against `Host` / `X-Forwarded-Host`
 * and `Sec-Fetch-Site`.
 */
export function verifySameOriginRequest(params: {
  method: string;
  originHeader: string | null;
  refererHeader: string | null;
  hostHeader: string | null;
  forwardedHostHeader?: string | null;
  secFetchSiteHeader?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const method = params.method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) {
    return { ok: true };
  }

  // Browser Fetch Metadata defense: immediately reject cross-site state-changing requests
  const secFetchSite = params.secFetchSiteHeader?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return { ok: false, reason: "Cross-site request blocked (Sec-Fetch-Site)." };
  }

  const expectedHost = (
    params.forwardedHostHeader?.split(",")[0]?.trim() ||
    params.hostHeader?.trim() ||
    ""
  ).toLowerCase();

  if (!expectedHost) {
    return { ok: false, reason: "Missing Host header." };
  }

  if (params.originHeader) {
    try {
      const originUrl = new URL(params.originHeader);
      if (originUrl.host.toLowerCase() !== expectedHost) {
        return {
          ok: false,
          reason: "Cross-origin mutation blocked (Origin mismatch).",
        };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Malformed Origin header." };
    }
  }

  if (params.refererHeader) {
    try {
      const refUrl = new URL(params.refererHeader);
      if (refUrl.host.toLowerCase() !== expectedHost) {
        return {
          ok: false,
          reason: "Cross-origin mutation blocked (Referer mismatch).",
        };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Malformed Referer header." };
    }
  }

  return {
    ok: false,
    reason: "Missing Origin and Referer headers on cookie-authenticated mutation.",
  };
}

export class PayloadTooLargeError extends Error {
  readonly httpStatus = 413;
  constructor(maxBytes: number) {
    super(
      `Request body exceeds the maximum allowed size of ${Math.round(
        maxBytes / 1024,
      ).toLocaleString()} KB.`,
    );
    this.name = "PayloadTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  readonly httpStatus = 400;
  constructor(message = "Invalid JSON request body.") {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

/**
 * Reads and parses a JSON request body while strictly enforcing `maxBytes` BEFORE
 * buffering unbounded payloads into memory.
 */
export async function readBoundedJson(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES_DEFAULT,
): Promise<unknown> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }

  const reader = req.body?.getReader();
  if (!reader) {
    return {};
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors
        }
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }

  if (totalBytes === 0) {
    return {};
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(combined);
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonBodyError();
  }
}

const INTERNAL_ERROR_PATTERNS = [
  /violates (foreign key|check|not-null|unique) constraint/i,
  /relation "[^"]+" does not exist/i,
  /column "[^"]+" (of relation|does not exist)/i,
  /syntax error at or near/i,
  /invalid input syntax for type/i,
  /permission denied for (table|schema|function|relation)/i,
  /new row violates row-level security/i,
  /pgrst\d+/i,
  /\bat\s+[\w$.]+\s*\(/i, // stack trace frame
];

/**
 * Sanitizes error messages before returning them to end users:
 * - Never exposes stack traces, SQL/PostgREST schema details, or internal file paths.
 * - Preserves intentional business-rule messages (e.g., "Plan limit exceeded...", "Expired...").
 */
export function sanitizeClientErrorMessage(
  err: unknown,
  fallback = "An unexpected error occurred. Please try again.",
): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown } | null)?.message === "string"
          ? String((err as { message: string }).message)
          : "";

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320) {
    return fallback;
  }

  for (const pattern of INTERNAL_ERROR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return fallback;
    }
  }

  return trimmed;
}

/**
 * Clamps any Supabase Storage signed URL expiration to `[5, MAX_SIGNED_URL_TTL_SECONDS]` (<= 60s).
 */
export function clampSignedUrlTtl(requestedSeconds = 60): number {
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    return MAX_SIGNED_URL_TTL_SECONDS;
  }
  return Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.max(5, Math.floor(requestedSeconds)));
}

/**
 * Verifies a Storage object path belongs strictly to `orgId` (and optional `eventId`)
 * with no path-traversal (`..`) or leading-slash tricks.
 */
export function assertOrgScopedStoragePath(params: {
  orgId: string;
  eventId?: string;
  objectPath: string;
}): void {
  const { orgId, eventId, objectPath } = params;
  const requiredPrefix = eventId ? `${orgId}/${eventId}/` : `${orgId}/`;
  if (
    !objectPath.startsWith(requiredPrefix) ||
    objectPath.includes("..") ||
    objectPath.startsWith("/")
  ) {
    throw new Error("Storage path does not belong to the current organization.");
  }
}
