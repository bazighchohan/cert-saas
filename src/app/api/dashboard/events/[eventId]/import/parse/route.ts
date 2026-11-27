import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  assertWithinPlan,
  isPlanEnforcementError,
} from "@/lib/plan-enforcement";
import { UuidSchema } from "@/lib/schemas";
import { checkCsrfOrigin, sanitizeClientErrorMessage } from "@/lib/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  autoDetectColumnMapping,
  parseUploadedSheetBytes,
} from "@/lib/tabular-import";

export const runtime = "nodejs";

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB max upload for CSV / XLSX
const ALLOWED_IMPORT_EXTENSIONS = new Set(["csv", "tsv", "txt", "xlsx", "xls"]);

/**
 * POST /api/dashboard/events/[eventId]/import/parse
 * Parses an uploaded .csv / .tsv / .txt / .xlsx file server-side, detects
 * delimiter & encoding (UTF-8, UTF-8 BOM, UTF-16 BOM, Windows-1252, XLSX),
 * returns headers + first 10 rows + suggested column mapping + raw rows (<= 5,000).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const csrf = checkCsrfOrigin(req);
  if (csrf) return csrf;

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_FILE_BYTES + 256 * 1024) {
    return NextResponse.json(
      { error: "Uploaded spreadsheet exceeds the 10 MB size limit." },
      { status: 413 },
    );
  }

  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId: rawEventId } = await context.params;
  const evParsed = UuidSchema.safeParse(rawEventId);
  if (!evParsed.success) {
    return NextResponse.json({ error: "Invalid event ID." }, { status: 400 });
  }
  const eventId = evParsed.data;

  try {
    await assertWithinPlan(org.id, eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    throw err;
  }

  const supabase = await createSupabaseServerClient();

  const [eventRes, typesRes] = await Promise.all([
    supabase
      .from("events")
      .select("id, identifier_label")
      .eq("id", eventId)
      .eq("org_id", org.id)
      .maybeSingle(),
    supabase
      .from("certificate_types")
      .select("id, key, label")
      .eq("org_id", org.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: true }),
  ]);

  if (!eventRes.data) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form upload." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { error: "Please select a non-empty .csv or .xlsx file to upload." },
      { status: 400 },
    );
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return NextResponse.json(
      { error: "Uploaded spreadsheet exceeds the 10 MB maximum size limit." },
      { status: 413 },
    );
  }
  const ext = file.name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: "Unsupported file type. Upload a .csv, .tsv, or .xlsx file." },
      { status: 400 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseUploadedSheetBytes(bytes, file.name);

    const certTypes = (typesRes.data ?? []).map((t) => ({
      id: t.id as string,
      key: t.key as string,
      label: t.label as string,
    }));

    const suggestedMapping = autoDetectColumnMapping(
      parsed.headers,
      (eventRes.data.identifier_label as string) ?? "Registration number",
      certTypes,
    );

    return NextResponse.json({
      fileName: file.name,
      format: parsed.format,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      sampleRows: parsed.sampleRows,
      rows: parsed.rows,
      totalDataRows: parsed.totalDataRows,
      suggestedMapping,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: sanitizeClientErrorMessage(
          err,
          "Could not parse the uploaded file.",
        ),
      },
      { status: 400 },
    );
  }
}
