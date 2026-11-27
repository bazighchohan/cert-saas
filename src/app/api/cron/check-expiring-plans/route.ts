import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifyCronAuthorization(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
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
 * 1. Marks overdue `active` purchases (`expires_at <= now()`) as `expired`
 *    and records `billing.purchase_expired` in `audit_log`.
 * 2. Lists active purchases expiring within 14 days (shown in `/superadmin`
 *    Platform Overview; sends no emails).
 */
export async function GET(req: NextRequest) {
  if (!verifyCronAuthorization(req.headers.get("authorization"))) {
    return NextResponse.json(
      { error: "Unauthorized cron invocation." },
      { status: 401 },
    );
  }

  const admin = getSupabaseAdmin();
  const withinDays = 14;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const soonIso = new Date(nowMs + withinDays * 86_400_000).toISOString();

  let newlyExpiredCount = 0;

  // Primary path: single transactional SQL RPC from 013_pricing_and_purchases.sql
  const { data: rpcData, error: rpcErr } = await admin.rpc(
    "run_daily_purchases_cron",
    {
      p_within_days: withinDays,
    },
  );

  if (!rpcErr && rpcData) {
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as {
      newly_expired_count?: number;
    };
    newlyExpiredCount = Number(row?.newly_expired_count ?? 0);
  } else {
    // Fallback query path if 013 RPC has not been applied yet
    const { data: newlyExp } = await admin
      .from("purchases")
      .update({ status: "expired" })
      .eq("status", "active")
      .lte("expires_at", nowIso)
      .select("id");
    newlyExpiredCount = newlyExp?.length ?? 0;
  }

  // List active purchases expiring within 14 days (no emails sent)
  const { data: expiringRows, error: listErr } = await admin
    .from("purchases")
    .select(
      "id, org_id, kind, events_used, events_total, certs_per_event, expires_at, is_pilot, organizations!inner(name, slug, status)",
    )
    .eq("status", "active")
    .gt("expires_at", nowIso)
    .lte("expires_at", soonIso)
    .order("expires_at", { ascending: true })
    .limit(200);

  if (listErr) {
    console.error("[cron:check-expiring-plans] list error:", listErr);
    return NextResponse.json(
      { error: "Failed to list expiring purchases." },
      { status: 500 },
    );
  }

  const expiringWithin14Days = (
    (expiringRows ?? []) as Array<Record<string, unknown>>
  )
    .filter((r) => {
      const orgRel = Array.isArray(r.organizations)
        ? (r.organizations[0] as Record<string, unknown> | undefined)
        : (r.organizations as Record<string, unknown> | undefined);
      return orgRel?.status === "active";
    })
    .map((r) => {
      const orgRel = Array.isArray(r.organizations)
        ? (r.organizations[0] as Record<string, unknown> | undefined)
        : (r.organizations as Record<string, unknown> | undefined);
      const expiresAt = String(r.expires_at);
      const daysRemaining = Math.max(
        1,
        Math.ceil((Date.parse(expiresAt) - nowMs) / 86_400_000),
      );
      return {
        purchaseId: String(r.id),
        orgId: String(r.org_id),
        orgName: String(orgRel?.name ?? ""),
        orgSlug: String(orgRel?.slug ?? ""),
        kind: String(r.kind),
        eventsUsed: Number(r.events_used ?? 0),
        eventsTotal: Number(r.events_total ?? 1),
        certsPerEvent: Number(r.certs_per_event ?? 50),
        isPilot: Boolean(r.is_pilot),
        expiresAt,
        daysRemaining,
      };
    });

  return NextResponse.json({
    ok: true,
    checkedAt: nowIso,
    withinDays,
    newlyExpiredCount,
    expiringSoonCount: expiringWithin14Days.length,
    expiringWithin14Days,
  });
}
