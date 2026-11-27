import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/dashboard";
  }
  return next;
}

/**
 * Handles Supabase email links for both:
 * - PKCE flow: ?code=...&next=/dashboard (or /reset-password)
 * - Token hash flow: ?token_hash=...&type=signup|recovery|email&next=...
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"));

  const supabase = await createSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("error", error.message);
      return NextResponse.redirect(loginUrl);
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    if (error) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("error", error.message);
      return NextResponse.redirect(loginUrl);
    }
  } else {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("error", "Invalid or missing confirmation link.");
    return NextResponse.redirect(loginUrl);
  }

  if (type === "recovery" || next === "/reset-password") {
    return NextResponse.redirect(new URL("/reset-password", req.url));
  }

  // Ensure the organization exists and enforce suspension check.
  const user = await getCurrentUser();
  const [{ org }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    isUserInSuperAdminsTable(user?.id),
  ]);

  if (!isSuperAdmin && (!org || org.status !== "active")) {
    return NextResponse.redirect(new URL("/pending", req.url));
  }

  return NextResponse.redirect(new URL(next, req.url));
}
