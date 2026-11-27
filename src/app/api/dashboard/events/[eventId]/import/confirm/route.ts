import "server-only";

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  assertWithinPlan,
  isPlanEnforcementError,
} from "@/lib/plan-enforcement";
import { ImportConfirmBodySchema, UuidSchema } from "@/lib/schemas";
import {
  checkCsrfOrigin,
  MAX_IMPORT_JSON_BODY_BYTES,
  parseValidatedJson,
  sanitizeClientErrorMessage,
} from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PreparedImportRow } from "@/lib/tabular-import";

export const runtime = "nodejs";

/**
 * POST /api/dashboard/events/[eventId]/import/confirm
 * Streams NDJSON progress events while importing up to 5,000 validated rows
 * inside a single database transaction (`bulk_import_event_attendees` RPC),
 * respecting plan limits and recording `attendee.csv_imported` in `audit_log`.
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
  const admin = getSupabaseAdmin();

  const parsedBody = await parseValidatedJson(
    req,
    ImportConfirmBodySchema,
    MAX_IMPORT_JSON_BODY_BYTES,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const preparedRows = parsedBody.data.preparedRows as PreparedImportRow[];
  const mode = parsedBody.data.mode;

  // Verify event belongs to org.id
  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const total = preparedRows.length;
        const batchCount = Math.max(1, Math.ceil(total / 500));

        send({
          type: "progress",
          percent: 15,
          message: `Preparing ${total.toLocaleString()} row(s) across ${batchCount} batch(es)...`,
        });

        const rpcPayload = preparedRows.map((r) => ({
          identifier: r.identifier,
          full_name: r.fullName,
          email: r.email ?? "",
          note: r.note ?? "",
          type_ids: r.typeIds ?? [],
        }));

        send({
          type: "progress",
          percent: 45,
          message: `Running transactional batch import (${batchCount} × 500 rows)...`,
        });

        // Primary path: single Postgres transaction via 008_bulk_import_attendees.sql RPC
        const { data: rpcData, error: rpcError } = await admin.rpc(
          "bulk_import_event_attendees",
          {
            p_org_id: org.id,
            p_user_id: user.id,
            p_event_id: eventId,
            p_mode: mode,
            p_rows: rpcPayload,
          },
        );

        if (!rpcError && rpcData) {
          const resRow = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as {
            inserted_count: number;
            updated_count: number;
            skipped_count: number;
            certificates_created_count: number;
          };

          send({
            type: "progress",
            percent: 100,
            message: "Import committed.",
          });

          revalidatePath(`/dashboard/events/${eventId}`);
          revalidatePath("/dashboard", "layout");

          send({
            type: "done",
            insertedCount: Number(resRow?.inserted_count ?? 0),
            updatedCount: Number(resRow?.updated_count ?? 0),
            skippedCount: Number(resRow?.skipped_count ?? 0),
            certificatesCreatedCount: Number(
              resRow?.certificates_created_count ?? 0,
            ),
          });
          controller.close();
          return;
        }

        // If RPC failed due to plan limit or validation, report immediately
        if (
          rpcError &&
          !/could not find the function|bulk_import_event_attendees/i.test(
            rpcError.message,
          )
        ) {
          send({
            type: "error",
            error: sanitizeClientErrorMessage(
              rpcError,
              "Import failed due to a validation or plan limit constraint.",
            ),
          });
          controller.close();
          return;
        }

        // Fallback path if 008_bulk_import_attendees.sql hasn't been applied in Supabase SQL Editor yet:
        // Pre-verify plan limits strictly via central assertWithinPlan before batching
        const { data: existingAttData } = await supabase
          .from("attendees")
          .select("id, identifier, attendee_certificates(certificate_type_id)")
          .eq("org_id", org.id)
          .eq("event_id", eventId);

        const existingMap = new Map<
          string,
          { id: string; certSet: Set<string> }
        >();
        for (const a of existingAttData ?? []) {
          const certs = Array.isArray(a.attendee_certificates)
            ? (a.attendee_certificates as Array<{ certificate_type_id: string }>)
            : [];
          existingMap.set(String(a.identifier).toLowerCase(), {
            id: a.id as string,
            certSet: new Set(certs.map((c) => c.certificate_type_id)),
          });
        }

        let projectedNewCerts = 0;
        let projectedNewAtt = 0;
        for (const r of preparedRows) {
          const ex = existingMap.get(r.identifier.toLowerCase());
          if (!ex) {
            projectedNewAtt++;
            projectedNewCerts += r.typeIds.length;
          } else if (mode === "update") {
            for (const tid of r.typeIds) {
              if (!ex.certSet.has(tid)) projectedNewCerts++;
            }
          }
        }

        try {
          await assertWithinPlan(org.id, eventId, {
            kind: "import",
            addAttendees: projectedNewAtt,
            addCertificates: projectedNewCerts,
          });
        } catch (err) {
          if (isPlanEnforcementError(err)) {
            send({ type: "error", error: err.message });
            controller.close();
            return;
          }
          throw err;
        }

        let insertedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        let certificatesCreatedCount = 0;

        const CHUNK = 250;
        for (let offset = 0; offset < total; offset += CHUNK) {
          const slice = preparedRows.slice(offset, offset + CHUNK);
          const toInsert: Array<Record<string, unknown>> = [];
          const newRowsMeta: PreparedImportRow[] = [];

          for (const r of slice) {
            const ex = existingMap.get(r.identifier.toLowerCase());
            if (!ex) {
              toInsert.push({
                org_id: org.id,
                event_id: eventId,
                identifier: r.identifier,
                full_name: r.fullName,
                email: r.email,
                note: r.note,
                source: "csv",
              });
              newRowsMeta.push(r);
            } else if (mode === "skip") {
              skippedCount++;
            } else {
              await supabase
                .from("attendees")
                .update({
                  full_name: r.fullName,
                  ...(r.email ? { email: r.email } : {}),
                  ...(r.note ? { note: r.note } : {}),
                })
                .eq("id", ex.id)
                .eq("org_id", org.id);
              updatedCount++;

              const missingTids = r.typeIds.filter(
                (tid) => !ex.certSet.has(tid),
              );
              if (missingTids.length > 0) {
                const { data: insC } = await supabase
                  .from("attendee_certificates")
                  .insert(
                    missingTids.map((tid) => ({
                      org_id: org.id,
                      event_id: eventId,
                      attendee_id: ex.id,
                      certificate_type_id: tid,
                    })),
                  )
                  .select("id");
                certificatesCreatedCount += insC?.length ?? 0;
              }
            }
          }

          if (toInsert.length > 0) {
            const { data: createdAtt, error: bErr } = await supabase
              .from("attendees")
              .insert(toInsert)
              .select("id, identifier");

            if (bErr) {
              console.error("[import:confirm] batch insert error:", bErr);
              send({
                type: "error",
                error: sanitizeClientErrorMessage(
                  bErr,
                  "Failed to insert attendee batch.",
                ),
              });
              controller.close();
              return;
            }

            insertedCount += createdAtt?.length ?? 0;
            const idByLower = new Map(
              (createdAtt ?? []).map((a) => [
                String(a.identifier).toLowerCase(),
                a.id as string,
              ]),
            );

            const certBatch: Array<Record<string, unknown>> = [];
            for (const nr of newRowsMeta) {
              const aid = idByLower.get(nr.identifier.toLowerCase());
              if (!aid) continue;
              for (const tid of nr.typeIds) {
                certBatch.push({
                  org_id: org.id,
                  event_id: eventId,
                  attendee_id: aid,
                  certificate_type_id: tid,
                });
              }
            }

            if (certBatch.length > 0) {
              const { data: cCreated } = await supabase
                .from("attendee_certificates")
                .insert(certBatch)
                .select("id");
              certificatesCreatedCount += cCreated?.length ?? 0;
            }
          }

          const pct = Math.min(
            95,
            Math.round(((offset + slice.length) / total) * 90) + 5,
          );
          send({
            type: "progress",
            percent: pct,
            message: `Imported ${Math.min(offset + slice.length, total).toLocaleString()} of ${total.toLocaleString()} rows...`,
          });
        }

        await admin.from("audit_log").insert({
          org_id: org.id,
          user_id: user.id,
          action: "attendee.csv_imported",
          details: {
            event_id: eventId,
            mode,
            inserted_count: insertedCount,
            updated_count: updatedCount,
            skipped_count: skippedCount,
            certificates_created_count: certificatesCreatedCount,
          },
        });

        revalidatePath(`/dashboard/events/${eventId}`);
        revalidatePath("/dashboard", "layout");

        send({
          type: "done",
          insertedCount,
          updatedCount,
          skippedCount,
          certificatesCreatedCount,
        });
        controller.close();
      } catch (err) {
        console.error("[import:confirm] unexpected failure:", err);
        send({
          type: "error",
          error: sanitizeClientErrorMessage(err, "Unexpected import failure."),
        });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
