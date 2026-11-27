import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import {
  createPublicLookupToken,
  escapeIlikeExact,
  GENERIC_LOOKUP_ERROR,
  getPublicEventPageState,
  normalizeForLookup,
} from "@/lib/public-event";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { EventSlugParamSchema, PublicLookupBodySchema } from "@/lib/schemas";
import { parseValidatedJson } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 12;
const ID_LIMIT = 6;
const WINDOW_MS = 60_000;

export interface PublicCertificateCardItem {
  attendeeCertificateId: string;
  certificateTypeId: string;
  key: string;
  label: string;
  pageWidthPt: number | null;
  pageHeightPt: number | null;
  downloadCount: number;
  downloadLimit: number | null;
  limitReached: boolean;
}

/**
 * POST /api/public/e/[slug]/lookup
 * Verifies identifier (+ full name if event.requireNameMatch) server-side with
 * case/space-insensitive matching.
 * Rate-limited by BOTH client IP and normalized identifier.
 * Always returns one generic error message on any lookup mismatch.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await context.params;
  const slugParsed = EventSlugParamSchema.safeParse(rawSlug);
  if (!slugParsed.success) {
    return NextResponse.json(
      { error: "Event not found.", code: "EVENT_NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const slug = slugParsed.data;
  const ip = clientIp(req);

  // 1. Distributed rate limit by IP
  const ipRl = await enforceRateLimit(`pub:lookup:ip:${ip}`, IP_LIMIT, WINDOW_MS);
  if (!ipRl.ok) {
    return NextResponse.json(
      {
        error: "Too many attempts. Please wait a minute and try again.",
        code: "RATE_LIMITED",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(ipRl.retryAfterSec),
        },
      },
    );
  }

  const parsedBody = await parseValidatedJson(req, PublicLookupBodySchema, 16 * 1024);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const normId = normalizeForLookup(parsedBody.data.identifier);
  const normName = normalizeForLookup(parsedBody.data.fullName);

  if (!normId || normId.length > 100) {
    return NextResponse.json(
      { error: "Please enter your valid identifier.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 2. Distributed rate limit by identifier within this event
  const idRl = await enforceRateLimit(
    `pub:lookup:id:${slug}:${normId}`,
    ID_LIMIT,
    WINDOW_MS,
  );
  if (!idRl.ok) {
    return NextResponse.json(
      {
        error: "Too many attempts for this identifier. Please wait a minute and try again.",
        code: "RATE_LIMITED",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(idRl.retryAfterSec),
        },
      },
    );
  }

  const pageState = await getPublicEventPageState(slug);
  if (pageState.state === "not_found") {
    return NextResponse.json(
      { error: "Event not found.", code: "EVENT_NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (pageState.state === "unavailable") {
    return NextResponse.json(
      {
        error: "This event page is currently unavailable.",
        code: "EVENT_UNAVAILABLE",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (pageState.state === "expired") {
    return NextResponse.json(
      {
        error: "This event has expired.",
        code: "EVENT_EXPIRED",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { event } = pageState;

  if (!event.released) {
    return NextResponse.json(
      {
        error: "Certificates for this event are not available yet.",
        code: "NOT_RELEASED",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (event.requireNameMatch && (!normName || normName.length > 200)) {
    return NextResponse.json(
      {
        error: `Please enter both your ${event.identifierLabel.toLowerCase()} and full name.`,
        code: "BAD_REQUEST",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const admin = getSupabaseAdmin();

  // 3. Scoped lookup by (org_id, event_id) + case/space-insensitive matching.
  //    First try exact case-insensitive match on normalized (trimmed + single-spaced)
  //    identifier so 5,000-row events hit the index directly without row-limit truncation;
  //    if not found and identifier contains spaces/hyphens, also check wildcard pattern.
  const exactPattern = escapeIlikeExact(normId);
  let { data: candidates, error: attErr } = await admin
    .from("attendees")
    .select("id, identifier, full_name")
    .eq("org_id", event.orgId)
    .eq("event_id", event.id)
    .ilike("identifier", exactPattern)
    .limit(5);

  if (!attErr && (!candidates || candidates.length === 0) && normId.includes(" ")) {
    const wildcardSpaces = normId
      .split(" ")
      .map(escapeIlikeExact)
      .join("%");
    const fallbackRes = await admin
      .from("attendees")
      .select("id, identifier, full_name")
      .eq("org_id", event.orgId)
      .eq("event_id", event.id)
      .ilike("identifier", wildcardSpaces)
      .limit(10);
    candidates = fallbackRes.data;
    attErr = fallbackRes.error;
  }

  if (attErr) {
    console.error("[public:lookup] DB error:", attErr);
    return NextResponse.json(
      {
        error: "Something went wrong on our side. Please try again in a moment.",
        code: "SERVER_ERROR",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const matchedAttendee = (candidates ?? []).find((row) => {
    if (normalizeForLookup(String(row.identifier)) !== normId) return false;
    if (
      event.requireNameMatch &&
      normalizeForLookup(String(row.full_name)) !== normName
    ) {
      return false;
    }
    return true;
  });

  if (!matchedAttendee) {
    return NextResponse.json(
      { error: GENERIC_LOOKUP_ERROR, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 4. Load attendee's assigned certificate types for this event
  const { data: certRows, error: certErr } = await admin
    .from("attendee_certificates")
    .select(
      "id, download_count, certificate_type_id, certificate_types!inner(*)",
    )
    .eq("org_id", event.orgId)
    .eq("event_id", event.id)
    .eq("attendee_id", matchedAttendee.id)
    .order("created_at", { ascending: true });

  if (certErr || !certRows || certRows.length === 0) {
    // Return the exact same generic error so we never leak whether an identifier exists without certs
    return NextResponse.json(
      { error: GENERIC_LOOKUP_ERROR, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const certificates: PublicCertificateCardItem[] = certRows.map((c) => {
    const ctRel = Array.isArray(c.certificate_types)
      ? (c.certificate_types[0] as Record<string, unknown>)
      : (c.certificate_types as Record<string, unknown>);

    const dlCount = Number(c.download_count ?? 0);
    const limitReached =
      event.downloadLimit !== null && dlCount >= event.downloadLimit;

    return {
      attendeeCertificateId: c.id as string,
      certificateTypeId: c.certificate_type_id as string,
      key: (ctRel?.key as string) ?? "certificate",
      label: (ctRel?.label as string) ?? "Certificate",
      pageWidthPt:
        ctRel?.page_width_pt != null ? Number(ctRel.page_width_pt) : null,
      pageHeightPt:
        ctRel?.page_height_pt != null ? Number(ctRel.page_height_pt) : null,
      downloadCount: dlCount,
      downloadLimit: event.downloadLimit,
      limitReached,
    };
  });

  const token = createPublicLookupToken({
    orgId: event.orgId,
    eventId: event.id,
    slug: event.slug,
    attendeeId: matchedAttendee.id as string,
    identifierLower: normId,
  });

  return NextResponse.json(
    {
      attendeeName: matchedAttendee.full_name as string,
      identifier: matchedAttendee.identifier as string,
      token,
      certificates,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
