import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  CertificateValidationError,
  generateCertificateDetailed,
  type QrPosition,
} from "@/lib/certificates";
import { fetchTemplateBytesFromStorage } from "@/lib/certificates/storage";
import { resolveCuratedFont } from "@/lib/fonts";
import { TestPdfBodySchema, UuidSchema } from "@/lib/schemas";
import {
  checkCsrfOrigin,
  parseValidatedJson,
  sanitizeClientErrorMessage,
} from "@/lib/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/dashboard/templates/[certTypeId]/test-pdf
 * Generates a real 1-page certificate PDF via `generateCertificateDetailed()`
 * using the certificate_types row, org metadata, event QR settings, and
 * cached Supabase Storage template bytes.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ certTypeId: string }> },
) {
  const csrf = checkCsrfOrigin(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { certTypeId: rawCertTypeId } = await context.params;
  const parsedId = UuidSchema.safeParse(rawCertTypeId);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: "Invalid certificate type ID." },
      { status: 400 },
    );
  }
  const certTypeId = parsedId.data;
  const supabase = await createSupabaseServerClient();

  const { data: certType, error } = await supabase
    .from("certificate_types")
    .select("*")
    .eq("id", certTypeId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (error || !certType) {
    return NextResponse.json(
      { error: "Certificate type not found." },
      { status: 404 },
    );
  }

  const { data: eventRow } = await supabase
    .from("events")
    .select("*")
    .eq("id", certType.event_id)
    .eq("org_id", org.id)
    .maybeSingle();

  const parsedBody = await parseValidatedJson(req, TestPdfBodySchema, 32 * 1024);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.data;

  const sampleName =
    typeof body.sampleName === "string" && body.sampleName.trim()
      ? body.sampleName.trim().slice(0, 200)
      : "Muhammad Abdul Rehman Chaudhry";

  const fontDef = resolveCuratedFont(
    typeof body.nameFont === "string"
      ? body.nameFont
      : (certType.name_font as string),
  );

  // Build effective certificate_types positioning row (live editor overrides fall back to DB row)
  const mergedRow = {
    label: certType.label as string,
    template_mime: certType.template_mime as string | null,
    page_index: Number(body.pageIndex ?? certType.page_index ?? 0),
    page_width_pt: certType.page_width_pt as number | null,
    page_height_pt: certType.page_height_pt as number | null,
    name_x: Number(body.nameXPt ?? certType.name_x),
    name_y: Number(body.nameYPt ?? certType.name_y),
    max_name_width: Number(body.maxNameWidthPt ?? certType.max_name_width),
    name_font: fontDef.id,
    name_bold:
      typeof body.nameBold === "boolean"
        ? body.nameBold
        : Boolean(certType.name_bold ?? true),
    name_size: Number(body.nameSizePt ?? certType.name_size ?? 34),
    name_color:
      typeof body.nameColor === "string" &&
      /^#[0-9A-Fa-f]{6}$/.test(body.nameColor)
        ? body.nameColor
        : ((certType.name_color as string) ?? "#0B2A4F"),
    name_align:
      body.nameAlign === "left" ||
      body.nameAlign === "center" ||
      body.nameAlign === "right"
        ? body.nameAlign
        : ((certType.name_align as string) ?? "center"),
  };

  try {
    const templateBytes = await fetchTemplateBytesFromStorage({
      orgId: org.id,
      eventId: certType.event_id as string,
      templatePath: (certType.template_path as string | null) ?? null,
    });

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL?.trim() &&
      !process.env.NEXT_PUBLIC_APP_URL.includes(".supabase.co")
        ? process.env.NEXT_PUBLIC_APP_URL.trim()
        : req.nextUrl.origin;

    const showQr = Boolean(
      (eventRow as Record<string, unknown> | null)?.show_qr ?? false,
    );
    const qrPosition = (((eventRow as Record<string, unknown> | null)
      ?.qr_position as QrPosition | undefined) ?? "bottom-right");
    const qrSizePt = Number(
      (eventRow as Record<string, unknown> | null)?.qr_size ?? 54,
    );

    const rendered = await generateCertificateDetailed({
      templateBytes,
      fullName: sampleName,
      verifyCode: "TESTVERIFY01",
      config: {
        certificateType: mergedRow,
        orgName: org.name,
        eventTitle: (eventRow?.title as string | undefined) ?? null,
        showQr,
        qrPosition,
        qrSizePt,
        verifyBaseUrl: appUrl,
      },
    });

    const safeFileSlug = (certType.key as string) || "certificate";
    return new NextResponse(Buffer.from(rendered.pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="test-${safeFileSlug}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Cert-Effective-Font-Size-Pt": String(rendered.effectiveFontSizePt),
        "X-Cert-Text-Draw-X-Pt": String(rendered.textDrawXPt),
        "X-Cert-Baseline-Y-Pt": String(rendered.baselineYPt),
        "X-Cert-Missing-Chars": encodeURIComponent(
          rendered.missingChars.join(""),
        ),
      },
    });
  } catch (err) {
    const isValidation = err instanceof CertificateValidationError;
    if (!isValidation) {
      console.error("[templates:test-pdf] render error:", err);
    }
    return NextResponse.json(
      {
        error: isValidation
          ? err.message
          : sanitizeClientErrorMessage(
              err,
              "Failed to generate test certificate PDF.",
            ),
      },
      { status: isValidation ? 400 : 500 },
    );
  }
}
