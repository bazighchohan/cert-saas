import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  computeDownloadsAnalytics,
  type DownloadStatusFilter,
} from "@/lib/downloads-analytics";
import { fetchEventDownloadsDataset } from "@/lib/downloads-data";
import { DownloadsQuerySchema, UuidSchema } from "@/lib/schemas";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/events/[eventId]/downloads
 * Returns summary cards, daily downloads chart series, pending emails list,
 * and paginated filterable rows strictly scoped via getCurrentOrg().
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId: rawEventId } = await context.params;
  const eventIdParsed = UuidSchema.safeParse(rawEventId);
  if (!eventIdParsed.success) {
    return NextResponse.json({ error: "Invalid event ID." }, { status: 400 });
  }
  const eventId = eventIdParsed.data;
  const supabase = await createSupabaseServerClient();

  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const qParsed = DownloadsQuerySchema.safeParse({
    status: sp.get("status") ?? "all",
    certTypeId: sp.get("certTypeId") ?? "",
    search: sp.get("search") ?? "",
    page: sp.get("page") ?? 1,
    pageSize: sp.get("pageSize") ?? 50,
  });
  if (!qParsed.success) {
    return NextResponse.json(
      { error: "Invalid download filter parameters." },
      { status: 400 },
    );
  }
  const { status: statusFilter, certTypeId, search, page, pageSize } = qParsed.data;

  try {
    const dataset = await fetchEventDownloadsDataset({
      supabase,
      orgId: org.id,
      eventId,
    });

    const analytics = computeDownloadsAnalytics({
      attendees: dataset.attendees,
      downloadLogs: dataset.downloadLogs,
      statusFilter,
      certTypeIdFilter: certTypeId,
      search,
    });

    const totalFiltered = analytics.filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;
    const rows = analytics.filteredRows.slice(offset, offset + pageSize);

    return NextResponse.json(
      {
        summary: {
          totalAttendees: analytics.totalAttendees,
          downloadedCount: analytics.downloadedCount,
          notDownloadedCount: analytics.notDownloadedCount,
          completionPct: analytics.completionPct,
          totalLogDownloads: analytics.totalLogDownloads,
        },
        pendingEmails: analytics.pendingEmails,
        dailySeries: analytics.dailySeries,
        rows,
        totalFiltered,
        page: safePage,
        pageSize,
        totalPages,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[downloads:GET] Failed to compute analytics:", err);
    return NextResponse.json(
      { error: "Failed to load download analytics." },
      { status: 500 },
    );
  }
}
