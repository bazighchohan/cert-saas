import "server-only";

import { NextResponse } from "next/server";
import { getCurrentOrg } from "@/lib/auth";

/**
 * True if the current request has a valid Supabase Auth session belonging to
 * an active organization. Replaces the legacy single-tenant ADMIN_PASSWORD check.
 */
export async function isAdmin(): Promise<boolean> {
  const org = await getCurrentOrg();
  return org !== null && org.status === "active";
}

/**
 * Guard for /api/admin/* handlers.
 * Returns a 401 response if not authenticated with an active org, otherwise null.
 */
export async function requireAdminApi(): Promise<NextResponse | null> {
  if (await isAdmin()) return null;
  return NextResponse.json(
    { error: "Unauthorized", code: "UNAUTHORIZED" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
