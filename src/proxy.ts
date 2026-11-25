import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 Proxy:
 * - Refreshes the Supabase Auth session cookie via @supabase/ssr.
 * - Requires login for /dashboard/** (and legacy /admin/** and /api/admin/**).
 * - Redirects logged-in users visiting /login or /signup to /dashboard.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname === "/admin/login") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  let res = NextResponse.next({
    request: { headers: req.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let isLoggedIn = false;

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
  }

  // Logged-in users visiting /login or /signup go straight to their requested destination or /dashboard.
  if (isLoggedIn && (pathname === "/login" || pathname === "/signup")) {
    const requestedNext = req.nextUrl.searchParams.get("next");
    const safeDest =
      requestedNext &&
      requestedNext.startsWith("/") &&
      !requestedNext.startsWith("//")
        ? requestedNext
        : "/dashboard";
    return NextResponse.redirect(new URL(safeDest, req.url));
  }

  const isProtectedPage =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/superadmin" ||
    pathname.startsWith("/superadmin/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  const isProtectedApi =
    ((pathname === "/api/admin" || pathname.startsWith("/api/admin/")) &&
      pathname !== "/api/admin/logout") ||
    pathname.startsWith("/api/dashboard/") ||
    pathname.startsWith("/api/superadmin/");

  if (!isLoggedIn && isProtectedApi) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!isLoggedIn && isProtectedPage) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  return res;
}

export const config = {
  matcher: [
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
