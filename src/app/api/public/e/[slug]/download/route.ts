import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { generateCertificate } from "@/lib/certificates";
import { fetchTemplateBytesFromStorage } from "@/lib/certificates/storage";
import {
  buildSafeCertificateFilename,
  getPublicEventBySlug,
  hashClientIp,
  verifyPublicLookupToken,
} from "@/lib/public-event";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { EventSlugParamSchema, PublicDownloadBodySchema } from "@/lib/schemas";
import { parseValidatedJson } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/public/e/[slug]/download
 * Enforces `events.download_limit` atomically via a single SQL
 * `UPDATE ... WHERE download_count < download_limit RETURNING` (`claim_certificate_download`),
 * logs the download to `download_log`, and streams the PDF with a safe filename.
 * Rate-limited by BOTH IP and identifier.
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
  const ipRl = await enforceRateLimit(`pub:dl:ip:${ip}`, 10, 60_000);
  if (!ipRl.ok) {
    return NextResponse.json(
      {
        error: "Too many download requests. Please wait a minute and try again.",
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

  const parsedBody = await parseValidatedJson(req, PublicDownloadBodySchema, 16 * 1024);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const { token, attendeeCertificateId } = parsedBody.data;
  const payload = verifyPublicLookupToken(token);
  if (!payload || payload.slug !== slug) {
    return NextResponse.json(
      {
        error: "Your lookup session expired. Please enter your details again.",
        code: "SESSION_EXPIRED",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 2. Distributed rate limit by identifier
  const idRl = await enforceRateLimit(
    `pub:dl:id:${payload.slug}:${payload.identifierLower}`,
    6,
    60_000,
  );
  if (!idRl.ok) {
    return NextResponse.json(
      {
        error: "Too many download attempts for this identifier. Please wait a minute.",
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
  if (
    !event ||
    event.id !== payload.eventId ||
    event.orgId !== payload.orgId
  ) {
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

  const admin = getSupabaseAdmin();

  // 3. Load attendee + certificate_type row scoped to (orgId, eventId, attendeeId)
  const { data: certRecord, error: fetchErr } = await admin
    .from("attendee_certificates")
    .select(
      "id, download_count, verify_code, attendees!inner(id, identifier, full_name), certificate_types!inner(*)",
    )
    .eq("id", attendeeCertificateId)
    .eq("org_id", event.orgId)
    .eq("event_id", event.id)
    .eq("attendee_id", payload.attendeeId)
    .maybeSingle();

  if (fetchErr || !certRecord) {
    return NextResponse.json(
      { error: "Certificate not found.", code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 4. Pre-load template bytes BEFORE claiming a download slot so a missing storage
  //    file never consumes the student's download limit.
  const attRel = (
    Array.isArray(certRecord.attendees)
      ? certRecord.attendees[0]
      : certRecord.attendees
  ) as Record<string, unknown>;
  const ctRel = (
    Array.isArray(certRecord.certificate_types)
      ? certRecord.certificate_types[0]
      : certRecord.certificate_types
  ) as Record<string, unknown>;

  let templateBytes: Uint8Array;
  try {
    templateBytes = await fetchTemplateBytesFromStorage({
      orgId: event.orgId,
      eventId: event.id,
      templatePath: (ctRel.template_path as string | null) ?? null,
    });
  } catch (err) {
    console.error("[public:download] Template load failed:", err);
    return NextResponse.json(
      {
        error: "Certificate template is temporarily unavailable. Please try again later.",
        code: "SERVER_ERROR",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 5. Atomically claim download slot via single SQL UPDATE ... WHERE download_count < limit RETURNING
  const ipHash = hashClientIp(ip);
  let newDownloadCount = 0;
  let verifyCode = String(certRecord.verify_code ?? "");

  const { data: claimData, error: claimErr } = await admin.rpc(
    "claim_certificate_download",
    {
      p_org_id: event.orgId,
      p_event_id: event.id,
      p_attendee_certificate_id: attendeeCertificateId,
      p_ip_hash: ipHash,
    },
  );

  if (!claimErr && claimData) {
    const claimRow = (
      Array.isArray(claimData) ? claimData[0] : claimData
    ) as {
      claimed: boolean;
      reason: string;
      new_download_count: number;
      verify_code: string | null;
    };

    if (!claimRow?.claimed) {
      if (claimRow?.reason === "org_suspended") {
        return NextResponse.json(
          {
            error: "This event page is currently unavailable.",
            code: "EVENT_UNAVAILABLE",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      if (claimRow?.reason === "not_released") {
        return NextResponse.json(
          {
            error: "Certificates for this event are not available yet.",
            code: "NOT_RELEASED",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      return NextResponse.json(
        {
          error:
            "Download limit reached for this certificate. Please contact the organizer if you need another copy.",
          code: "DOWNLOAD_LIMIT_REACHED",
          downloadLimit: event.downloadLimit,
          contactEmail: event.contactEmail,
          contactPhone: event.contactPhone,
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    newDownloadCount = Number(claimRow.new_download_count ?? 1);
    if (claimRow.verify_code) verifyCode = claimRow.verify_code;
  } else {
    // Atomic CAS fallback if 009_atomic_certificate_download.sql has not been applied yet:
    // Single SQL UPDATE with `.eq("download_count", observedCount)` + `< limit` check
    // guarantees two parallel requests cannot both match `download_count = observedCount`!
    const observedCount = Number(certRecord.download_count ?? 0);
    if (
      event.downloadLimit !== null &&
      observedCount >= event.downloadLimit
    ) {
      return NextResponse.json(
        {
          error:
            "Download limit reached for this certificate. Please contact the organizer if you need another copy.",
          code: "DOWNLOAD_LIMIT_REACHED",
          downloadLimit: event.downloadLimit,
          contactEmail: event.contactEmail,
          contactPhone: event.contactPhone,
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const nowIso = new Date().toISOString();
    const { data: casUpdated, error: casErr } = await admin
      .from("attendee_certificates")
      .update({
        download_count: observedCount + 1,
        ...(observedCount === 0 ? { first_downloaded_at: nowIso } : {}),
        last_downloaded_at: nowIso,
      })
      .eq("id", attendeeCertificateId)
      .eq("org_id", event.orgId)
      .eq("event_id", event.id)
      .eq("download_count", observedCount)
      .select("id, download_count")
      .maybeSingle();

    if (casErr || !casUpdated) {
      // Lost race to a concurrent download request!
      return NextResponse.json(
        {
          error:
            "Download limit reached or another download is already in progress. Please contact the organizer if you need assistance.",
          code: "DOWNLOAD_LIMIT_REACHED",
          downloadLimit: event.downloadLimit,
          contactEmail: event.contactEmail,
          contactPhone: event.contactPhone,
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    newDownloadCount = Number(casUpdated.download_count ?? observedCount + 1);
    await admin.from("download_log").insert({
      org_id: event.orgId,
      attendee_certificate_id: attendeeCertificateId,
      ip_hash: ipHash,
    });
  }

  // 6. Generate personalized PDF and stream with safe filename
  try {
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() &&
      !process.env.NEXT_PUBLIC_APP_URL.includes(".supabase.co")
        ? process.env.NEXT_PUBLIC_APP_URL.trim()
        : req.nextUrl.origin;

    const pdfBytes = await generateCertificate({
      templateBytes,
      fullName: String(attRel.full_name ?? ""),
      verifyCode,
      config: {
        certificateType: ctRel,
        orgName: event.orgName,
        eventTitle: event.title,
        showQr: event.showQr,
        qrPosition: event.qrPosition,
        qrSizePt: event.qrSizePt,
        verifyBaseUrl: appUrl,
      },
    });

    const filename = buildSafeCertificateFilename(
      event.slug,
      String(ctRel.key ?? "certificate"),
      String(attRel.identifier ?? "attendee"),
    );

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-New-Download-Count": String(newDownloadCount),
      },
    });
  } catch (err) {
    console.error("[public:download] PDF generation failed:", err);
    return NextResponse.json(
      {
        error: "Failed to generate your certificate PDF. Please try again.",
        code: "SERVER_ERROR",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
