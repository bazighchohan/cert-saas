export type GateOrgStatus = "pending" | "active" | "rejected" | "suspended";

export type ProxyGateDecision =
  | { action: "allow" }
  | { action: "redirect"; destination: string }
  | {
      action: "json_error";
      httpStatus: 401 | 403;
      code: "UNAUTHORIZED" | "ORG_NOT_ACTIVE";
      error: string;
      orgStatus?: GateOrgStatus | null;
      redirectTo?: string;
    };

/**
 * Pure, deterministic access-gate evaluator shared by `src/proxy.ts` and tests.
 * Rules:
 * 1. Unauthenticated users hitting protected pages -> redirect to `/login?next=...` (or `/login` for `/pending`),
 *    hitting protected APIs -> 401 JSON.
 * 2. Super admins (`isSuperAdmin === true`) are exempt from non-active org redirects/blocks.
 * 3. Logged-in users whose organization is NOT `'active'` (`pending`, `rejected`, `suspended`, or missing)
 *    are:
 *      - Redirected from EVERY `/dashboard/**` (and `/admin/**`) route to `/pending`
 *      - Blocked with 403 `ORG_NOT_ACTIVE` on EVERY `/api/dashboard/**` (and `/api/admin/**`) route
 *      - Redirected from `/login` and `/signup` to `/pending`
 * 4. Logged-in users whose organization IS `'active'` visiting `/pending` are redirected to `/dashboard`.
 */
export function evaluateProxyAccessGate(input: {
  pathname: string;
  search?: string;
  isLoggedIn: boolean;
  isSuperAdmin: boolean;
  hasOrg: boolean;
  orgStatus: GateOrgStatus | null;
  requestedNext?: string | null;
}): ProxyGateDecision {
  const {
    pathname,
    search = "",
    isLoggedIn,
    isSuperAdmin,
    hasOrg,
    orgStatus,
    requestedNext,
  } = input;

  const isDashboardPage =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  const isSuperAdminPage =
    pathname === "/superadmin" || pathname.startsWith("/superadmin/");

  const isPendingPage = pathname === "/pending";

  const isDashboardApi =
    pathname.startsWith("/api/dashboard/") ||
    ((pathname === "/api/admin" || pathname.startsWith("/api/admin/")) &&
      pathname !== "/api/admin/logout");

  const isSuperAdminApi = pathname.startsWith("/api/superadmin/");

  if (!isLoggedIn) {
    if (isDashboardApi || isSuperAdminApi) {
      return {
        action: "json_error",
        httpStatus: 401,
        code: "UNAUTHORIZED",
        error: "Unauthorized",
      };
    }
    if (isPendingPage) {
      return { action: "redirect", destination: "/login" };
    }
    if (isDashboardPage || isSuperAdminPage) {
      const encoded = encodeURIComponent(`${pathname}${search}`);
      return {
        action: "redirect",
        destination: `/login?next=${encoded}`,
      };
    }
    return { action: "allow" };
  }

  // Logged-in user: check active status vs superadmin exemption
  const isOrgActive = hasOrg && orgStatus === "active";
  const isBlockedByOrgGate = !isSuperAdmin && !isOrgActive;

  if (pathname === "/login" || pathname === "/signup") {
    if (isBlockedByOrgGate) {
      return { action: "redirect", destination: "/pending" };
    }
    const safeDest =
      requestedNext &&
      requestedNext.startsWith("/") &&
      !requestedNext.startsWith("//")
        ? requestedNext
        : "/dashboard";
    return { action: "redirect", destination: safeDest };
  }

  if (isPendingPage) {
    if (isOrgActive && !isSuperAdmin) {
      return { action: "redirect", destination: "/dashboard" };
    }
    return { action: "allow" };
  }

  if (isDashboardPage && isBlockedByOrgGate) {
    return { action: "redirect", destination: "/pending" };
  }

  if (isDashboardApi && isBlockedByOrgGate) {
    return {
      action: "json_error",
      httpStatus: 403,
      code: "ORG_NOT_ACTIVE",
      error:
        orgStatus === "rejected"
          ? "Your organization request was not approved."
          : orgStatus === "suspended"
            ? "Your organization account is suspended."
            : "Your organization is pending approval.",
      orgStatus,
      redirectTo: "/pending",
    };
  }

  return { action: "allow" };
}
