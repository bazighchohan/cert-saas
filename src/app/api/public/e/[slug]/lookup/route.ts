import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import {
  createPublicLookupToken,
  escapeIlikeExact,
  GENERIC_LOOKUP_ERROR,
  getPublicEventBySlug,
  normalizeForLookup,
} from "@/lib/public-event";
import { clientIp, rateLimit } from "@/lib/rate-limit";
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
  const { slug } = await context.params;
  const ip = clientIp(req);

  // 1. Rate limit by IP
  const ipRl = rateLimit(`pub:lookup:ip:${ip}`, IP_LIMIT, WINDOW_MS);
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

  let body: { identifier?: unknown; fullName?: unknown };
  try {
    body = (await req.json()) as { identifier?: unknown; fullName?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Please enter your details and try again.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawIdentifier =
    typeof body.identifier === "string" ? body.identifier : "";
  const rawFullName = typeof body.fullName === "string" ? body.fullName : "";

  const normId = normalizeForLookup(rawIdentifier);
  const normName = normalizeForLookup(rawFullName);

  if (!normId || normId.length > 100) {
    return NextResponse.json(
      { error: "Please enter your valid identifier.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 2. Rate limit by identifier within this event
  const idRl = rateLimit(
    `pub:lookup:id:${slug.toLowerCase()}:${normId}`,
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

  const event = await getPublicEventBySlug(slug);
  if (!event) {
    return NextResponse.json(
      { error: "Event not found.", code: "EVENT_NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

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

  // 3. Scoped lookup by (org_id, event_id) + case/space-insensitive matching
  const { data: candidates, error: attErr } = await admin
    .from("attendees")
    .select("id, identifier, full_name")
    .eq("org_id", event.orgId)
    .eq("event_id", event.id)
    .ilike("identifier", `%${escapeIlikeExact(normId.split(" ")[0])}%`)
    .limit(20);

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
      "id, download_count, certificate_type_id, certificate_types!inner(id, key, label)",
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
