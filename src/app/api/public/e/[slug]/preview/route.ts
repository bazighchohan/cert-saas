import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { generateCertificate } from "@/lib/certificates";
import { fetchTemplateBytesFromStorage } from "@/lib/certificates/storage";
import {
  getPublicEventPageState,
  verifyPublicLookupToken,
} from "@/lib/public-event";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import {
  SAMPLE_ATTENDEES,
  SAMPLE_EVENT_SLUG,
} from "@/lib/sample-event";
import { EventSlugParamSchema, PublicPreviewQuerySchema } from "@/lib/schemas";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/public/e/[slug]/preview?token=...&certId=...
 * Streams the rendered 1-page PDF strictly for rendering the client-side
 * preview image on the certificate card WITHOUT incrementing download_count.
 * Protected by the short-lived HMAC lookup token + IP & identifier rate limits.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await context.params;
  const slugParsed = EventSlugParamSchema.safeParse(rawSlug);
  if (!slugParsed.success) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }
  const slug = slugParsed.data;
  const ip = clientIp(req);

  const ipRl = await enforceRateLimit(`pub:preview:ip:${ip}`, 24, 60_000);
  if (!ipRl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfterSec) } },
    );
  }

  const queryParsed = PublicPreviewQuerySchema.safeParse({
    token: req.nextUrl.searchParams.get("token") ?? "",
    certId: req.nextUrl.searchParams.get("certId") ?? "",
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: "Invalid preview parameters." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { token, certId } = queryParsed.data;
  const payload = verifyPublicLookupToken(token);
  if (!payload || payload.slug !== slug) {
    return NextResponse.json(
      { error: "Preview session expired. Please look up your certificate again." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const idRl = await enforceRateLimit(
    `pub:preview:id:${payload.slug}:${payload.identifierLower}`,
    16,
    60_000,
  );
  if (!idRl.ok) {
    return NextResponse.json(
      { error: "Too many preview requests." },
      { status: 429, headers: { "Retry-After": String(idRl.retryAfterSec) } },
    );
  }

  const pageState = await getPublicEventPageState(slug);
  if (pageState.state === "expired") {
    return NextResponse.json(
      { error: "This event has expired.", code: "EVENT_EXPIRED" },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }
  const event = pageState.state === "ok" ? pageState.event : null;
  if (!event || !event.released || event.id !== payload.eventId || event.orgId !== payload.orgId) {
    return NextResponse.json(
      { error: "Certificates are not available." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (slug === SAMPLE_EVENT_SLUG) {
    const sampleAtt = SAMPLE_ATTENDEES.find((a) => a.id === payload.attendeeId);
    const sampleCert = sampleAtt?.certificates.find(
      (c) => c.attendeeCertificateId === certId,
    );
    if (!sampleAtt || !sampleCert) {
      return NextResponse.json(
        { error: "Certificate not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const templateBytes = await fetchTemplateBytesFromStorage({
      orgId: event.orgId,
      eventId: event.id,
      templatePath: null,
    });
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() &&
      !process.env.NEXT_PUBLIC_APP_URL.includes(".supabase.co")
        ? process.env.NEXT_PUBLIC_APP_URL.trim()
        : req.nextUrl.origin;
    const pdfBytes = await generateCertificate({
      templateBytes,
      fullName: sampleAtt.fullName,
      verifyCode: sampleCert.verifyCode,
      config: {
        certificateType: sampleCert.certificateTypeRow,
        orgName: event.orgName,
        eventTitle: event.title,
        showQr: event.showQr,
        qrPosition: event.qrPosition,
        qrSizePt: event.qrSizePt,
        verifyBaseUrl: appUrl,
      },
    });
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
      },
    });
  }

  const admin = getSupabaseAdmin();
  const { data: row, error } = await admin
    .from("attendee_certificates")
    .select(
      "id, verify_code, attendees!inner(id, full_name), certificate_types!inner(*)",
    )
    .eq("id", certId)
    .eq("org_id", event.orgId)
    .eq("event_id", event.id)
    .eq("attendee_id", payload.attendeeId)
    .maybeSingle();

  if (error || !row) {
    return NextResponse.json(
      { error: "Certificate not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const attRel = Array.isArray(row.attendees) ? row.attendees[0] : row.attendees;
  const ctRel = (
    Array.isArray(row.certificate_types)
      ? row.certificate_types[0]
      : row.certificate_types
  ) as Record<string, unknown>;

  try {
    const templateBytes = await fetchTemplateBytesFromStorage({
      orgId: event.orgId,
      eventId: event.id,
      templatePath: (ctRel.template_path as string | null) ?? null,
    });

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() &&
      !process.env.NEXT_PUBLIC_APP_URL.includes(".supabase.co")
        ? process.env.NEXT_PUBLIC_APP_URL.trim()
        : req.nextUrl.origin;

    const pdfBytes = await generateCertificate({
      templateBytes,
      fullName: String((attRel as Record<string, unknown>).full_name ?? ""),
      verifyCode: String(row.verify_code ?? ""),
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

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[public:preview] Render error:", err);
    return NextResponse.json(
      { error: "Failed to render certificate preview." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
