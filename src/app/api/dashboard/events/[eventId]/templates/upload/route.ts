import "server-only";

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  MAX_TEMPLATE_BYTES,
  validateAndInspectTemplate,
} from "@/lib/template-validator";

export const runtime = "nodejs";

/**
 * Ensures the private "templates" bucket exists in Supabase Storage.
 */
async function ensureTemplatesBucket() {
  const admin = getSupabaseAdmin();
  const { data: bucket } = await admin.storage.getBucket("templates");
  if (!bucket) {
    await admin.storage.createBucket("templates", {
      public: false,
      fileSizeLimit: MAX_TEMPLATE_BYTES,
      allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"],
    });
  }
}

/**
 * POST /api/dashboard/events/[eventId]/templates/upload
 * Multipart form fields:
 * - file: File (PDF, PNG, or JPG, max 5 MB)
 * - certTypeId: string (target certificate_types.id belonging to org + event)
 * - pageIndex?: string (optional 0-based page index for multi-page PDFs)
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const { eventId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const certTypeId = String(formData.get("certTypeId") || "").trim();
  const rawPageIndex = Number(formData.get("pageIndex") ?? 0);
  const requestedPageIndex = Number.isFinite(rawPageIndex) && rawPageIndex >= 0
    ? Math.floor(rawPageIndex)
    : 0;

  if (!certTypeId) {
    return NextResponse.json(
      { error: "certTypeId is required." },
      { status: 400 },
    );
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Please select a PDF, PNG, or JPG file to upload." },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: "Uploaded file is empty." },
      { status: 400 },
    );
  }

  if (file.size > MAX_TEMPLATE_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 5 MB maximum size limit." },
      { status: 400 },
    );
  }

  // Verify the certificate type belongs to this org and this event.
  const { data: certType, error: certErr } = await supabase
    .from("certificate_types")
    .select("id, key, label, template_path")
    .eq("id", certTypeId)
    .eq("event_id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (certErr || !certType) {
    return NextResponse.json(
      { error: "Certificate type not found for your organization." },
      { status: 404 },
    );
  }

  // Server-side MIME + magic bytes + encrypted PDF check + dimension extraction in points.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = await validateAndInspectTemplate(
    bytes,
    file.type,
    requestedPageIndex,
  );

  if (!inspection.valid || !inspection.mimeType || !inspection.extension) {
    return NextResponse.json(
      { error: inspection.error || "Invalid template file." },
      { status: 400 },
    );
  }

  await ensureTemplatesBucket();

  // Strictly scoped object key under {org_id}/{event_id}/...
  const objectPath = `${org.id}/${eventId}/${certTypeId}-${Date.now()}.${inspection.extension}`;

  const { error: uploadErr } = await admin.storage
    .from("templates")
    .upload(objectPath, bytes, {
      contentType: inspection.mimeType,
      upsert: true,
    });

  if (uploadErr) {
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadErr.message}` },
      { status: 500 },
    );
  }

  // Remove previous file if replacing an older template.
  const previousPath = certType.template_path as string | null;
  if (
    previousPath &&
    previousPath !== objectPath &&
    previousPath.startsWith(`${org.id}/${eventId}/`)
  ) {
    try {
      await admin.storage.from("templates").remove([previousPath]);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Save path and page dimensions in points on certificate_types.
  // Use core columns first, and update extended metadata columns added in 004_storage_templates.sql.
  const { error: updateErr } = await supabase
    .from("certificate_types")
    .update({
      template_path: objectPath,
      template_mime: inspection.mimeType,
      page_width_pt: inspection.pageWidthPt,
      page_height_pt: inspection.pageHeightPt,
      page_count: inspection.pageCount,
      page_index: inspection.pageIndex,
    })
    .eq("id", certTypeId)
    .eq("event_id", eventId)
    .eq("org_id", org.id);

  if (updateErr) {
    // Fallback if 004_storage_templates.sql extended columns haven't been migrated yet
    const { error: fallbackErr } = await supabase
      .from("certificate_types")
      .update({
        template_path: objectPath,
        page_index: inspection.pageIndex,
      })
      .eq("id", certTypeId)
      .eq("event_id", eventId)
      .eq("org_id", org.id);

    if (fallbackErr) {
      return NextResponse.json(
        { error: fallbackErr.message },
        { status: 500 },
      );
    }
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "certificate_type.template_uploaded",
      details: {
        event_id: eventId,
        certificate_type_id: certTypeId,
        template_path: objectPath,
        mime_type: inspection.mimeType,
        page_width_pt: inspection.pageWidthPt,
        page_height_pt: inspection.pageHeightPt,
        page_count: inspection.pageCount,
        page_index: inspection.pageIndex,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for template upload:", err);
  }

  revalidatePath(`/dashboard/events/${eventId}`);

  return NextResponse.json({
    success: true,
    templatePath: objectPath,
    templateMime: inspection.mimeType,
    pageWidthPt: inspection.pageWidthPt,
    pageHeightPt: inspection.pageHeightPt,
    pageCount: inspection.pageCount,
    pageIndex: inspection.pageIndex,
  });
}
