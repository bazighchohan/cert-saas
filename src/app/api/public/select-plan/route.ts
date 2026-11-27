import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import {
  buildDirectSignupQueryHref,
  parsePlanSelectionFromParams,
  PLAN_SELECTION_COOKIE_MAX_AGE_SEC,
  PLAN_SELECTION_COOKIE_NAME,
  signPlanSelectionCookie,
} from "@/lib/plan-selection-cookie";
import { getPricingAndPresets } from "@/lib/pricing-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCookieSecret(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "cert-saas-plan-cookie-fallback-secret"
  );
}

/**
 * GET /api/public/select-plan?plan=...
 * Validates the chosen plan against live `pricing_config` + `plans`, stores an
 * HMAC-signed cookie so the choice persists across navigation, and redirects to `/signup`.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const { pricingConfig, presets } = await getPricingAndPresets();

  const choice = parsePlanSelectionFromParams(
    {
      plan: searchParams.get("plan"),
      events: searchParams.get("events"),
      certs: searchParams.get("certs"),
      months: searchParams.get("months"),
    },
    pricingConfig,
    presets,
  );

  if (!choice) {
    return NextResponse.redirect(new URL("/signup", req.url));
  }

  const targetHref = buildDirectSignupQueryHref(choice);
  const res = NextResponse.redirect(new URL(targetHref, req.url));

  const signed = signPlanSelectionCookie(choice, getCookieSecret());
  res.cookies.set(PLAN_SELECTION_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PLAN_SELECTION_COOKIE_MAX_AGE_SEC,
  });

  return res;
}
