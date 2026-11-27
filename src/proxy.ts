import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import {
  evaluateProxyAccessGate,
  type GateOrgStatus,
} from "@/lib/access-gate";
import { verifySameOriginRequest } from "@/lib/security-helpers";

function copySetCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}

function normalizeGateStatus(raw: unknown): GateOrgStatus | null {
  if (
    raw === "pending" ||
    raw === "active" ||
    raw === "rejected" ||
    raw === "suspended"
  ) {
    return raw;
  }
  return null;
}

/**
 * Next.js 16 Proxy:
 * - Enforces CSRF same-origin verification on cookie-authenticated API mutations.
 * - Refreshes the Supabase Auth session cookie via @supabase/ssr.
 * - Enforces the pilot approval access gate: any logged-in user whose organization
 *   is not 'active' is redirected from EVERY /dashboard route to /pending and
 *   blocked with 403 on EVERY /api/dashboard route (super_admins are exempt).
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname === "/admin/login") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const isCookieAuthenticatedApi =
    pathname.startsWith("/api/dashboard/") ||
    pathname.startsWith("/api/superadmin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/");

  if (isCookieAuthenticatedApi) {
    const csrf = verifySameOriginRequest({
      method: req.method,
      originHeader: req.headers.get("origin"),
      refererHeader: req.headers.get("referer"),
      hostHeader: req.headers.get("host"),
      forwardedHostHeader: req.headers.get("x-forwarded-host"),
      secFetchSiteHeader: req.headers.get("sec-fetch-site"),
    });
    if (!csrf.ok) {
      return NextResponse.json(
        {
          error: "Cross-origin request blocked by CSRF protection.",
          code: "CSRF_BLOCKED",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  let res = NextResponse.next({
    request: { headers: req.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let isLoggedIn = false;
  let isSuperAdmin = false;
  let hasOrg = false;
  let orgStatus: GateOrgStatus | null = null;

  if (url && anonKey) {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            req.cookies.set(name, value);
          }
          res = NextResponse.next({
            request: { headers: req.headers },
          });
          for (const { name, value, options } of cookiesToSet) {
            res.cookies.set(name, value, options);
          }
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();
    isLoggedIn = Boolean(user);

    if (user) {
      const { data: gateData, error: gateErr } = await supabase.rpc(
        "get_my_access_gate_status",
      );

      if (!gateErr && gateData) {
        const row = (Array.isArray(gateData) ? gateData[0] : gateData) as
          | Record<string, unknown>
          | undefined;
        if (row) {
          isSuperAdmin = Boolean(row.is_super_admin);
          hasOrg = Boolean(row.has_org);
          orgStatus = normalizeGateStatus(row.org_status);
        }
      } else if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // Fallback if migration 014 RPC has not been applied yet in local dev
        const adminClient = createClient(
          url,
          process.env.SUPABASE_SERVICE_ROLE_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const [superRes, memRes] = await Promise.all([
          adminClient
            .from("super_admins")
            .select("user_id")
            .eq("user_id", user.id)
            .maybeSingle(),
          adminClient
            .from("organization_members")
            .select("organizations!inner(status)")
            .eq("user_id", user.id)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle(),
        ]);
        isSuperAdmin = Boolean(superRes.data?.user_id);
        const orgRel = memRes.data?.organizations as
          | { status?: string }
          | Array<{ status?: string }>
          | undefined;
        const orgObj = Array.isArray(orgRel) ? orgRel[0] : orgRel;
        if (orgObj) {
          hasOrg = true;
          orgStatus = normalizeGateStatus(orgObj.status);
        }
      }
    }
  }

  const decision = evaluateProxyAccessGate({
    pathname,
    search,
    isLoggedIn,
    isSuperAdmin,
    hasOrg,
    orgStatus,
    requestedNext: req.nextUrl.searchParams.get("next"),
  });

  if (decision.action === "redirect") {
    const redirectRes = NextResponse.redirect(
      new URL(decision.destination, req.url),
    );
    return copySetCookies(res, redirectRes);
  }

  if (decision.action === "json_error") {
    const jsonRes = NextResponse.json(
      {
        error: decision.error,
        code: decision.code,
        ...(decision.orgStatus ? { status: decision.orgStatus } : {}),
        ...(decision.redirectTo ? { redirectTo: decision.redirectTo } : {}),
      },
      {
        status: decision.httpStatus,
        headers: { "Cache-Control": "no-store" },
      },
    );
    return copySetCookies(res, jsonRes);
  }

  return res;
}

export const config = {
  matcher: [
    "/pending",
    "/dashboard",
    "/dashboard/:path*",
    "/superadmin",
    "/superadmin/:path*",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/admin",
    "/admin/:path*",
    "/api/admin",
    "/api/admin/:path*",
    "/api/dashboard/:path*",
    "/api/superadmin/:path*",
  ],
};
