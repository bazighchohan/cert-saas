import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  assertWithinPlan,
  isPlanEnforcementError,
} from "@/lib/plan-enforcement";
import { ImportPreviewBodySchema, UuidSchema } from "@/lib/schemas";
import {
  checkCsrfOrigin,
  MAX_IMPORT_JSON_BODY_BYTES,
  parseValidatedJson,
  sanitizeClientErrorMessage,
} from "@/lib/security";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildErrorReportCsv,
  validateMappedImportRows,
  type ColumnMappingConfig,
  type ExistingAttendeeSnapshot,
} from "@/lib/tabular-import";

export const runtime = "nodejs";

/**
 * POST /api/dashboard/events/[eventId]/import/preview
 * Evaluates all mapped rows against event normalization, duplicate-in-file rules,
 * existing attendees in the event, and organization plan quotas.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const csrf = checkCsrfOrigin(req);
  if (csrf) return csrf;

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

  const parsedBody = await parseValidatedJson(
    req,
    ImportPreviewBodySchema,
    MAX_IMPORT_JSON_BODY_BYTES,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const rows = parsedBody.data.rows;
  const mapping = parsedBody.data.mapping as ColumnMappingConfig;

  const [eventRes, typesRes, eventCertsRes, orgCertsRes] =
    await Promise.all([
      supabase
        .from("events")
        .select("*")
        .eq("id", eventId)
        .eq("org_id", org.id)
        .maybeSingle(),
      supabase
        .from("certificate_types")
        .select("id, key, label")
        .eq("org_id", org.id)
        .eq("event_id", eventId)
        .order("created_at", { ascending: true }),
      supabase
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org.id)
        .eq("event_id", eventId),
      supabase
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org.id),
    ]);

  if (!eventRes.data) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const ev = eventRes.data as Record<string, unknown>;
  const identifierLabel =
    (ev.identifier_label as string) ?? "Registration number";
  const uppercaseIdentifiers =
    ev.uppercase_identifiers === undefined
      ? true
      : Boolean(ev.uppercase_identifiers);

  // Load all existing attendees + their assigned certificate types in this event (paginated in 1,000-row pages)
  const existingByLowerId = new Map<string, ExistingAttendeeSnapshot>();
  let pageOffset = 0;
  const FETCH_CHUNK = 1000;
  for (;;) {
    const { data: attBatch, error: attErr } = await supabase
      .from("attendees")
      .select("id, identifier, attendee_certificates(certificate_type_id)")
      .eq("org_id", org.id)
      .eq("event_id", eventId)
      .range(pageOffset, pageOffset + FETCH_CHUNK - 1);

    if (attErr) {
      console.error("[import:preview] attendees query error:", attErr);
      return NextResponse.json(
        { error: "Failed to load existing attendees for validation." },
        { status: 500 },
      );
    }
    if (!attBatch || attBatch.length === 0) break;

    for (const a of attBatch) {
      const certsRaw = Array.isArray(a.attendee_certificates)
        ? (a.attendee_certificates as Array<{ certificate_type_id: string }>)
        : [];
      existingByLowerId.set(String(a.identifier).toLowerCase(), {
        id: a.id as string,
        identifier: a.identifier as string,
        certificateTypeIds: new Set(certsRaw.map((c) => c.certificate_type_id)),
      });
    }

    if (attBatch.length < FETCH_CHUNK) break;
    pageOffset += FETCH_CHUNK;
  }

  const maxCertificatesPerEvent = Math.max(
    1,
    Number(ev.max_certificates ?? 50),
  );

  try {
    const report = validateMappedImportRows({
      rows,
      mapping,
      identifierLabel,
      uppercaseIdentifiers,
      certTypes: (typesRes.data ?? []).map((t) => ({
        id: t.id as string,
        key: t.key as string,
        label: t.label as string,
      })),
      existingByLowerId,
      quotaContext: {
        planName: org.packageLabel,
        eventAttendeesCurrent: existingByLowerId.size,
        eventCertsCurrent: eventCertsRes.count ?? 0,
        maxCertificatesPerEvent,
        orgCertsCurrent: orgCertsRes.count ?? 0,
        maxCertificatesTotal: null,
      },
    });

    const errorCsv =
      report.issues.length > 0 ? buildErrorReportCsv(report.issues) : null;

    return NextResponse.json({
      report,
      errorCsv,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: sanitizeClientErrorMessage(
          err,
          "Validation failed for mapped columns.",
        ),
      },
      { status: 400 },
    );
  }
}
