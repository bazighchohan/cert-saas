import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { renderCustomCertificate } from "@/lib/certificate";
import { TEMPLATE_FILE } from "@/lib/config";
import { resolveCuratedFont } from "@/lib/fonts";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { TemplateMimeType } from "@/lib/template-validator";

export const runtime = "nodejs";

/**
 * POST /api/dashboard/templates/[certTypeId]/test-pdf
 * Generates a real 1-page certificate PDF with the admin's sample name and
 * current placement settings (either unsaved live overrides or saved DB values).
 * Falls back to the bundled blank sample template if the type has no uploaded file yet.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ certTypeId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { certTypeId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

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

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const sampleName =
    typeof body.sampleName === "string" && body.sampleName.trim()
      ? body.sampleName.trim().slice(0, 200)
      : "Muhammad Abdul Rehman Chaudhry";

  const pageWidthDefault = Number(certType.page_width_pt ?? 843.75);
  const pageHeightDefault = Number(certType.page_height_pt ?? 597.75);

  const rawX = Number(body.nameXPt ?? certType.name_x ?? pageWidthDefault * 0.5);
  const rawY = Number(body.nameYPt ?? certType.name_y ?? 265);
  const rawMaxW = Number(
    body.maxNameWidthPt ?? certType.max_name_width ?? pageWidthDefault * 0.55,
  );

  // Handle legacy 0..1 ratio rows smoothly if 005 migration hasn't run yet
  const nameXPt = rawX <= 1 ? Number((pageWidthDefault * rawX).toFixed(2)) : rawX;
  const nameYPt = rawY <= 1 ? Number((pageHeightDefault * (1 - rawY)).toFixed(2)) : rawY;
  const maxNameWidthPt =
    rawMaxW <= 1 ? Number((pageWidthDefault * rawMaxW).toFixed(2)) : rawMaxW;

  const fontDef = resolveCuratedFont(
    typeof body.nameFont === "string"
      ? body.nameFont
      : (certType.name_font as string),
  );
  const nameBold =
    typeof body.nameBold === "boolean"
      ? body.nameBold
      : Boolean(certType.name_bold ?? true);
  const nameSizePt = Math.max(
    4,
    Math.min(300, Number(body.nameSizePt ?? certType.name_size ?? 34)),
  );
  const nameColorHex =
    typeof body.nameColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(body.nameColor)
      ? body.nameColor
      : ((certType.name_color as string) ?? "#0B2A4F");
  const nameAlign =
    body.nameAlign === "left" ||
    body.nameAlign === "center" ||
    body.nameAlign === "right"
      ? body.nameAlign
      : (((certType.name_align as string) ?? "center") as
          | "left"
          | "center"
          | "right");

  const pageIndex = Number(body.pageIndex ?? certType.page_index ?? 0);

  let templateBytes: Uint8Array;
  let templateMime: TemplateMimeType | null =
    (certType.template_mime as TemplateMimeType | null) ?? null;

  const templatePath = certType.template_path as string | null;
  if (templatePath && templatePath.startsWith(`${org.id}/${certType.event_id}/`)) {
    const { data: blob, error: dlErr } = await admin.storage
      .from("templates")
      .download(templatePath);

    if (dlErr || !blob) {
      return NextResponse.json(
        { error: "Could not download template from storage." },
        { status: 404 },
      );
    }
    templateBytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    // Fallback to the bundled blank sample PDF so admin can test before uploading
    const samplePath = path.join(process.cwd(), "public", TEMPLATE_FILE);
    templateBytes = new Uint8Array(await readFile(samplePath));
    templateMime = "application/pdf";
  }

  try {
    const rendered = await renderCustomCertificate({
      templateBytes,
      templateMime,
      pageIndex,
      pageWidthPt: pageWidthDefault,
      pageHeightPt: pageHeightDefault,
      recipientName: sampleName,
      nameXPt,
      nameYPt,
      maxNameWidthPt,
      nameFont: fontDef.id,
      nameBold,
      nameSizePt,
      nameColorHex,
      nameAlign,
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
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to generate test certificate PDF.",
      },
      { status: 500 },
    );
  }
}
