import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { AttendeesQuerySchema, UuidSchema } from "@/lib/schemas";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AttendeeSortField =
  | "created_at"
  | "identifier"
  | "full_name"
  | "email"
  | "source"
  | "downloads";

export interface AttendeeCertificateBadge {
  id: string;
  certificateTypeId: string;
  downloadCount: number;
  verifyCode: string;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
}

export interface AttendeeListItem {
  id: string;
  identifier: string;
  fullName: string;
  email: string | null;
  source: "csv" | "manual";
  note: string | null;
  createdAt: string;
  totalDownloads: number;
  certificates: AttendeeCertificateBadge[];
}

function sanitizePostgrestSearch(raw: string): string {
  // Strip characters that break PostgREST .or() filter syntax
  return raw.replace(/[,()*%\\]/g, " ").trim().slice(0, 100);
}

/**
 * GET /api/dashboard/events/[eventId]/attendees
 * Server-side paginated (50/page default), searchable, sortable attendees list
 * strictly scoped to getCurrentOrg() + eventId.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { eventId: rawEventId } = await context.params;
  const eventIdParsed = UuidSchema.safeParse(rawEventId);
  if (!eventIdParsed.success) {
    return NextResponse.json(
      { error: "Invalid event ID." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const eventId = eventIdParsed.data;
  const supabase = await createSupabaseServerClient();

  // Verify the event belongs to the current organization
  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return NextResponse.json(
      { error: "Event not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const sp = req.nextUrl.searchParams;
  const queryParsed = AttendeesQuerySchema.safeParse({
    page: sp.get("page") ?? 1,
    pageSize: sp.get("pageSize") ?? 50,
    search: sp.get("search") ?? "",
    source: sp.get("source") ?? "",
    sortBy: sp.get("sortBy") ?? "created_at",
    sortDir: sp.get("sortDir") ?? "desc",
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters.", code: "VALIDATION_ERROR" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const {
    page,
    pageSize,
    search: rawSearch,
    source: sourceFilter,
    sortBy,
    sortDir,
  } = queryParsed.data;
  const ascending = sortDir === "asc";

  // Fetch current certificate quota usage in parallel
  const quotaPromise = Promise.all([
    supabase.from("plans").select("*").eq("id", org.planId).maybeSingle(),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("event_id", eventId),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);

  let query = supabase
    .from("attendees")
    .select(
      "id, identifier, full_name, email, source, note, created_at, attendee_certificates(id, certificate_type_id, download_count, verify_code, first_downloaded_at, last_downloaded_at)",
      { count: "exact" },
    )
    .eq("org_id", org.id)
    .eq("event_id", eventId);

  if (sourceFilter === "csv" || sourceFilter === "manual") {
    query = query.eq("source", sourceFilter);
  }

  if (rawSearch) {
    const term = sanitizePostgrestSearch(rawSearch);
    if (term) {
      query = query.or(
        `identifier.ilike.%${term}%,full_name.ilike.%${term}%,email.ilike.%${term}%,note.ilike.%${term}%`,
      );
    }
  }

  const mapAttendeeRow = (row: Record<string, unknown>): AttendeeListItem => {
    const rawCerts = Array.isArray(row.attendee_certificates)
      ? (row.attendee_certificates as Array<Record<string, unknown>>)
      : [];

    const certificates: AttendeeCertificateBadge[] = rawCerts.map((c) => ({
      id: c.id as string,
      certificateTypeId: c.certificate_type_id as string,
      downloadCount: Number(c.download_count ?? 0),
      verifyCode: c.verify_code as string,
      firstDownloadedAt: (c.first_downloaded_at as string | null) ?? null,
      lastDownloadedAt: (c.last_downloaded_at as string | null) ?? null,
    }));

    const totalDownloads = certificates.reduce(
      (sum, c) => sum + c.downloadCount,
      0,
    );

    return {
      id: row.id as string,
      identifier: row.identifier as string,
      fullName: row.full_name as string,
      email: (row.email as string | null) ?? null,
      source: ((row.source as string) === "manual" ? "manual" : "csv") as
        | "csv"
        | "manual",
      note: (row.note as string | null) ?? null,
      createdAt: row.created_at as string,
      totalDownloads,
      certificates,
    };
  };

  let attendees: AttendeeListItem[] = [];
  let totalCount = 0;

  if (sortBy === "downloads") {
    // Aggregate download count sort across matching attendees in this event
    const { data, error, count } = await query.order("created_at", {
      ascending: false,
    });
    if (error) {
      console.error("[attendees:GET] DB error:", error);
      return NextResponse.json(
        { error: "Failed to load attendees." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    const allMapped = (data ?? []).map((r) =>
      mapAttendeeRow(r as Record<string, unknown>),
    );
    allMapped.sort((a, b) =>
      ascending
        ? a.totalDownloads - b.totalDownloads ||
          a.identifier.localeCompare(b.identifier)
        : b.totalDownloads - a.totalDownloads ||
          a.identifier.localeCompare(b.identifier),
    );
    totalCount = count ?? allMapped.length;
    const offset = (page - 1) * pageSize;
    attendees = allMapped.slice(offset, offset + pageSize);
  } else {
    const offset = (page - 1) * pageSize;
    const { data, error, count } = await query
      .order(sortBy, { ascending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error("[attendees:GET] DB error:", error);
      return NextResponse.json(
        { error: "Failed to load attendees." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

    totalCount = count ?? 0;
    attendees = (data ?? []).map((r) =>
      mapAttendeeRow(r as Record<string, unknown>),
    );
  }

  const [planRes, eventCertsRes, orgCertsRes] = await quotaPromise;
  const planData = planRes.data as Record<string, unknown> | null;

  return NextResponse.json(
    {
      attendees,
      totalCount,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      quota: {
        planName: (planData?.name as string) ?? org.planId,
        eventCertsUsed: eventCertsRes.count ?? 0,
        maxCertificatesPerEvent:
          planData?.max_certificates_per_event === undefined
            ? 50
            : ((planData.max_certificates_per_event as number | null) ?? null),
        orgCertsUsed: orgCertsRes.count ?? 0,
        maxCertificatesTotal:
          planData?.max_certificates_total === undefined
            ? 50
            : ((planData.max_certificates_total as number | null) ?? null),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
