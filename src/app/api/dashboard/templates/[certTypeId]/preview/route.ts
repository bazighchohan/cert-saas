import "server-only";

import { PDFDocument } from "pdf-lib";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { UuidSchema } from "@/lib/schemas";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { detectMagicMime } from "@/lib/template-validator";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/templates/[certTypeId]/preview
 * Streams the uploaded template for an authenticated organization member.
 * For PDF templates, extracts only the selected page (`page_index`) into a
 * single-page PDF so thumbnail previews display the exact chosen page.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ certTypeId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { certTypeId: rawCertTypeId } = await context.params;
  const parsedId = UuidSchema.safeParse(rawCertTypeId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid certificate type ID." }, { status: 400 });
  }
  const certTypeId = parsedId.data;
  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: certType, error } = await supabase
    .from("certificate_types")
    .select("id, org_id, event_id, template_path, page_index")
    .eq("id", certTypeId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (error || !certType || !certType.template_path) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }

  const templatePath = certType.template_path as string;
  const expectedPrefix = `${org.id}/${certType.event_id}/`;
  if (!templatePath.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { data: blob, error: dlErr } = await admin.storage
    .from("templates")
    .download(templatePath);

  if (dlErr || !blob) {
    return NextResponse.json(
      { error: "Could not download template from storage." },
      { status: 404 },
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = detectMagicMime(bytes);

  if (!mime) {
    return NextResponse.json(
      { error: "Unsupported template format." },
      { status: 400 },
    );
  }

  // If PDF, extract the single selected page so the thumbnail renders that exact page.
  if (mime === "application/pdf") {
    const requestedPage = Number(
      req.nextUrl.searchParams.get("page") ?? certType.page_index ?? 0,
    );
    try {
      const srcDoc = await PDFDocument.load(bytes, { updateMetadata: false });
      const total = srcDoc.getPageCount();
      const idx =
        Number.isFinite(requestedPage) && requestedPage >= 0 && requestedPage < total
          ? Math.floor(requestedPage)
          : 0;

      const singlePageDoc = await PDFDocument.create();
      const [copiedPage] = await singlePageDoc.copyPages(srcDoc, [idx]);
      singlePageDoc.addPage(copiedPage);
      const singleBytes = await singlePageDoc.save();

      return new NextResponse(Buffer.from(singleBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline; filename=\"template-preview.pdf\"",
          "Cache-Control": "private, no-store",
        },
      });
    } catch {
      return new NextResponse(Buffer.from(bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "private, no-store",
        },
      });
    }
  }

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, no-store",
    },
  });
}
