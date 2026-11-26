import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import {
  clampSignedUrlTtl,
  InvalidJsonBodyError,
  MAX_IMPORT_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES_DEFAULT,
  MAX_SIGNED_URL_TTL_SECONDS,
  PayloadTooLargeError,
  readBoundedJson,
  sanitizeClientErrorMessage,
  verifySameOriginRequest,
} from "@/lib/security-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

export {
  clampSignedUrlTtl,
  InvalidJsonBodyError,
  MAX_IMPORT_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES_DEFAULT,
  MAX_SIGNED_URL_TTL_SECONDS,
  PayloadTooLargeError,
  readBoundedJson,
  sanitizeClientErrorMessage,
  verifySameOriginRequest,
};

/**
 * Enforces CSRF same-origin verification on cookie-authenticated mutations.
 * Returns `null` if valid, or a `403 Forbidden` NextResponse if cross-origin.
 */
export function checkCsrfOrigin(req: Request | NextRequest): NextResponse | null {
  const check = verifySameOriginRequest({
    method: req.method,
    originHeader: req.headers.get("origin"),
    refererHeader: req.headers.get("referer"),
    hostHeader: req.headers.get("host"),
    forwardedHostHeader: req.headers.get("x-forwarded-host"),
    secFetchSiteHeader: req.headers.get("sec-fetch-site"),
  });

  if (check.ok) return null;

  return NextResponse.json(
    {
      error: "Cross-origin request blocked by CSRF protection.",
      code: "CSRF_BLOCKED",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Reads a bounded JSON request body and validates it with a `zod` schema.
 * Returns `{ ok: true, data }` or `{ ok: false, response: NextResponse }`.
 */
export async function parseValidatedJson<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
  maxBytes = MAX_JSON_BODY_BYTES_DEFAULT,
): Promise<
  | { ok: true; data: z.infer<TSchema> }
  | { ok: false; response: NextResponse }
> {
  let raw: unknown;
  try {
    raw = await readBoundedJson(req, maxBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: err.message, code: "PAYLOAD_TOO_LARGE" },
          { status: 413, headers: { "Cache-Control": "no-store" } },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid JSON payload.", code: "BAD_REQUEST" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const fieldPath =
      firstIssue && firstIssue.path.length > 0
        ? `${firstIssue.path.join(".")}: `
        : "";
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `${fieldPath}${firstIssue?.message || "Invalid request input."}`,
          code: "VALIDATION_ERROR",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Formats the first Zod issue into a clean user-facing message for Server Actions.
 */
export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  return issue.message;
}

/**
 * Generates a short-lived signed URL (`<= 60` seconds) for a private Supabase
 * Storage object, enforcing that `objectPath` begins with `${orgId}/` and contains
 * no path traversal sequences.
 */
export async function createShortSignedStorageUrl(params: {
  bucket: "templates" | "payment-proofs";
  orgId: string;
  objectPath: string;
  ttlSeconds?: number;
}): Promise<string> {
  const { bucket, orgId, objectPath, ttlSeconds = 60 } = params;

  if (
    !objectPath.startsWith(`${orgId}/`) ||
    objectPath.includes("..") ||
    objectPath.startsWith("/")
  ) {
    throw new Error("Forbidden storage object path.");
  }

  const expiresIn = clampSignedUrlTtl(ttlSeconds);
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(bucket)
    .createSignedUrl(objectPath, expiresIn);

  if (error || !data?.signedUrl) {
    throw new Error("Could not create signed storage URL.");
  }

  return data.signedUrl;
}
