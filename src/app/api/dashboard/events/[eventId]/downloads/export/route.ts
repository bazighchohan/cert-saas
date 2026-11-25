import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  buildDownloadsExportCsv,
  buildDownloadsExportXlsx,
  computeDownloadsAnalytics,
  type DownloadStatusFilter,
} from "@/lib/downloads-analytics";
import { fetchEventDownloadsDataset } from "@/lib/downloads-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/events/[eventId]/downloads/export?status=downloaded|not_downloaded|all&format=csv|xlsx&certTypeId=...
 * Exports Downloaded, Not Downloaded, or All attendees in either UTF-8 BOM CSV
 * or native Excel (.xlsx) format.
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

  const { eventId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { data: event } = await supabase
    .from("events")
    .select("id, slug, identifier_label")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const statusRaw = sp.get("status") ?? "downloaded";
  const statusFilter: DownloadStatusFilter =
    statusRaw === "downloaded" ||
    statusRaw === "not_downloaded" ||
    statusRaw === "all"
      ? statusRaw
      : "downloaded";
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  const certTypeId = sp.get("certTypeId") ?? "";

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
    });

    const identifierLabel =
      (event.identifier_label as string) ?? "Registration number";
    const safeSlug = String(event.slug || "event").replace(
      /[^a-z0-9_-]/gi,
      "_",
    );
    const dateStamp = new Date().toISOString().slice(0, 10);
    const baseFilename = `${safeSlug}-${statusFilter}-${dateStamp}`;

    if (format === "xlsx") {
      const sheetName =
        statusFilter === "downloaded"
          ? "Downloaded"
          : statusFilter === "not_downloaded"
            ? "Not Downloaded"
            : "All Attendees";

      const xlsxBytes = buildDownloadsExportXlsx(
        analytics.filteredRows,
        identifierLabel,
        sheetName,
      );

      return new NextResponse(Buffer.from(xlsxBytes), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${baseFilename}.xlsx"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const csvBody = buildDownloadsExportCsv(
      analytics.filteredRows,
      identifierLabel,
    );

    return new NextResponse(csvBody, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseFilename}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[downloads:export] Export failed:", err);
    return NextResponse.json(
      { error: "Failed to generate export file." },
      { status: 500 },
    );
  }
}
