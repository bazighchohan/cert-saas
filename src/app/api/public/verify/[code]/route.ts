import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { lookupCertificateByVerifyCode } from "@/lib/public-verify";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { VerifyCodeSchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/public/verify/[code]
 * Distributed rate-limited public certificate verification endpoint.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const ip = clientIp(req);
  const rl = await enforceRateLimit(`pub:verify:ip:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "Too many verification requests. Please wait a minute.",
        code: "RATE_LIMITED",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  const { code } = await context.params;
  const parsed = VerifyCodeSchema.safeParse(code);
  if (!parsed.success) {
    return NextResponse.json(
      { valid: false, error: "Certificate verification code not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const res = await lookupCertificateByVerifyCode(parsed.data);
  if (res.status === "unavailable") {
    return NextResponse.json(
      {
        valid: false,
        error: "Verification is currently unavailable for this organization.",
        code: "EVENT_UNAVAILABLE",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (res.status !== "valid") {
    return NextResponse.json(
      { valid: false, error: "No matching verified certificate found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { valid: true, certificate: res.certificate },
    { headers: { "Cache-Control": "no-store" } },
  );
}
