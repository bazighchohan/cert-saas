import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifyCronAuthorization(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // Allow local dev testing only when NODE_ENV !== 'production'; require CRON_SECRET in production.
    return process.env.NODE_ENV !== "production";
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const provided = authHeader.slice("Bearer ".length).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * GET /api/cron/check-expiring-plans
 * Invoked daily by Vercel Cron (`vercel.json`: `0 2 * * *`).
 * Flags organizations whose paid plans expire within 7 days (`plan_expiring_soon = true`),
 * logs newly expired read-only organizations to `audit_log`, and clears stale flags.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronAuthorization(req.headers.get("authorization"))) {
    return NextResponse.json(
      { error: "Unauthorized cron invocation." },
      { status: 401 },
    );
  }

  const admin = getSupabaseAdmin();
  const withinDays = 7;

  // Primary path: single SQL RPC from 011_billing_and_plan_enforcement.sql
  const { data, error } = await admin.rpc("flag_expiring_organizations", {
    p_within_days: withinDays,
  });

  if (!error && data) {
    const row = (Array.isArray(data) ? data[0] : data) as {
      flagged_expiring_soon_count?: number;
      newly_expired_count?: number;
      cleared_count?: number;
    };

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      withinDays,
      flaggedExpiringSoonCount: Number(row?.flagged_expiring_soon_count ?? 0),
      newlyExpiredCount: Number(row?.newly_expired_count ?? 0),
      clearedCount: Number(row?.cleared_count ?? 0),
    });
  }

  // Fallback query path if RPC is unavailable
  const nowIso = new Date().toISOString();
  const soonIso = new Date(
    Date.now() + withinDays * 86_400_000,
  ).toISOString();

  const { data: flaggedRows, error: fallbackErr } = await admin
    .from("organizations")
    .update({
      plan_expiring_soon: true,
      expiry_flagged_at: nowIso,
    })
    .eq("status", "active")
    .eq("plan_expiring_soon", false)
    .gt("plan_expires_at", nowIso)
    .lte("plan_expires_at", soonIso)
    .select("id");

  if (fallbackErr) {
    return NextResponse.json(
      { error: error?.message || fallbackErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    checkedAt: nowIso,
    withinDays,
    flaggedExpiringSoonCount: flaggedRows?.length ?? 0,
    newlyExpiredCount: 0,
    clearedCount: 0,
  });
}
