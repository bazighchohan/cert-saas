import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  autoDetectColumnMapping,
  parseUploadedSheetBytes,
} from "@/lib/tabular-import";

export const runtime = "nodejs";

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
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await context.params;
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
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Please select a .csv or .xlsx file to upload." },
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
        error:
          err instanceof Error
            ? err.message
            : "Could not parse the uploaded file.",
      },
      { status: 400 },
    );
  }
}
