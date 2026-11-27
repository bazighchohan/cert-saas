"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateAttendeeFields } from "@/lib/attendee-validation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  assertWithinPlan,
  isPlanEnforcementError,
  type PlanErrorCode,
} from "@/lib/plan-enforcement";
import {
  AddAttendeeInputSchema,
  BulkDeleteAttendeesInputSchema,
  BulkSetCertTypeInputSchema,
  DeleteAttendeeInputSchema,
  ResetAttendeeDownloadsInputSchema,
  SaveAttendeeIssueNoteInputSchema,
  SetAttendeeCertTypeInputSchema,
  UpdateAttendeeInputSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AttendeeActionResult {
  success?: boolean;
  error?: string;
  code?:
    | PlanErrorCode
    | "DUPLICATE_IDENTIFIER"
    | "VALIDATION_ERROR"
    | "NOT_FOUND";
  attendeeId?: string;
  affectedCount?: number;
}

interface EventLookupRow {
  id: string;
  identifierLabel: string;
  uppercaseIdentifiers: boolean;
}

async function loadScopedEvent(
  supabase: SupabaseClient,
  orgId: string,
  eventId: string,
): Promise<EventLookupRow | null> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    identifierLabel:
      (row.identifier_label as string) ?? "Registration number",
    uppercaseIdentifiers:
      row.uppercase_identifiers === undefined
        ? true
        : Boolean(row.uppercase_identifiers),
  };
}

/**
 * Central plan & expiration wrapper for attendee / certificate mutations.
 */
async function enforceAttendeePlan(
  orgId: string,
  eventId: string,
  newCertificatesCount: number,
  addingNewAttendee = false,
): Promise<{ ok: true } | { ok: false; error: string; code: PlanErrorCode }> {
  try {
    await assertWithinPlan(orgId, eventId, {
      kind: addingNewAttendee ? "attendee" : "certificate",
      addAttendees: addingNewAttendee ? 1 : 0,
      addCertificates: newCertificatesCount,
    });
    return { ok: true };
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { ok: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

async function enforceWriteAccess(
  orgId: string,
  eventId?: string,
): Promise<{ ok: true } | { ok: false; error: string; code: PlanErrorCode }> {
  try {
    await assertWithinPlan(orgId, eventId ?? null, "write");
    return { ok: true };
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { ok: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

/**
 * Adds a single attendee manually, assigns selected certificate types,
 * enforces duplicate check + plan limits, and writes to audit_log.
 */
export async function addAttendeeAction(input: {
  eventId: string;
  identifier: string;
  fullName: string;
  email?: string;
  note?: string;
  certificateTypeIds: string[];
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const addParsed = AddAttendeeInputSchema.safeParse(input);
  if (!addParsed.success) {
    return { error: formatZodError(addParsed.error), code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const event = await loadScopedEvent(supabase, org.id, addParsed.data.eventId);
  if (!event) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  const validated = validateAttendeeFields({
    identifier: input.identifier,
    fullName: input.fullName,
    email: input.email,
    note: input.note,
    uppercaseIdentifiers: event.uppercaseIdentifiers,
    identifierLabel: event.identifierLabel,
  });

  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  // Case-insensitive duplicate check within this event
  const { data: existingDup } = await supabase
    .from("attendees")
    .select("id, identifier")
    .eq("org_id", org.id)
    .eq("event_id", input.eventId)
    .ilike("identifier", validated.clean.identifier.replace(/[%_\\]/g, "\\$&"))
    .limit(1)
    .maybeSingle();

  if (existingDup) {
    return {
      code: "DUPLICATE_IDENTIFIER",
      error: `An attendee with ${event.identifierLabel} "${existingDup.identifier}" already exists in this event.`,
    };
  }

  // Validate requested certificateTypeIds belong to this event
  const uniqueTypeIds = Array.from(new Set(input.certificateTypeIds));
  let validTypeIds: string[] = [];
  if (uniqueTypeIds.length > 0) {
    const { data: validTypes } = await supabase
      .from("certificate_types")
      .select("id")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId)
      .in("id", uniqueTypeIds);

    validTypeIds = (validTypes ?? []).map((t) => t.id as string);
  }

  // Enforce plan limits & active/unexpired check via assertWithinPlan
  const quota = await enforceAttendeePlan(
    org.id,
    input.eventId,
    validTypeIds.length,
    true,
  );

  if (!quota.ok) {
    return { error: quota.error, code: quota.code };
  }

  // Insert attendee
  const { data: created, error: insertErr } = await supabase
    .from("attendees")
    .insert({
      org_id: org.id,
      event_id: input.eventId,
      identifier: validated.clean.identifier,
      full_name: validated.clean.fullName,
      email: validated.clean.email,
      note: validated.clean.note,
      source: "manual",
    })
    .select("id")
    .maybeSingle();

  if (insertErr || !created) {
    if (insertErr?.code === "23505") {
      return {
        code: "DUPLICATE_IDENTIFIER",
        error: `An attendee with ${event.identifierLabel} "${validated.clean.identifier}" already exists in this event.`,
      };
    }
    return { error: sanitizeClientErrorMessage(insertErr, "Failed to add attendee.") };
  }

  const attendeeId = created.id as string;

  // Assign selected certificate types
  if (validTypeIds.length > 0) {
    const certRows = validTypeIds.map((typeId) => ({
      org_id: org.id,
      event_id: input.eventId,
      attendee_id: attendeeId,
      certificate_type_id: typeId,
    }));

    const { error: certErr } = await supabase
      .from("attendee_certificates")
      .insert(certRows);

    if (certErr) {
      // Roll back attendee row so no partial state remains
      await supabase
        .from("attendees")
        .delete()
        .eq("id", attendeeId)
        .eq("org_id", org.id);
      return {
        error: sanitizeClientErrorMessage(certErr, "Failed to assign certificate(s)."),
      };
    }
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.created",
      details: {
        event_id: input.eventId,
        attendee_id: attendeeId,
        identifier: validated.clean.identifier,
        full_name: validated.clean.fullName,
        certificate_types_count: validTypeIds.length,
        source: "manual",
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for attendee.created:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, attendeeId };
}

/**
 * Inline-edits an attendee's identifier, full_name, email, and note.
 * Normalizes identifier, rejects duplicates with a friendly message, and writes audit_log.
 */
export async function updateAttendeeAction(input: {
  eventId: string;
  attendeeId: string;
  identifier: string;
  fullName: string;
  email?: string | null;
  note?: string | null;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const updParsed = UpdateAttendeeInputSchema.safeParse(input);
  if (!updParsed.success) {
    return { error: formatZodError(updParsed.error), code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const event = await loadScopedEvent(supabase, org.id, updParsed.data.eventId);
  if (!event) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  const validated = validateAttendeeFields({
    identifier: input.identifier,
    fullName: input.fullName,
    email: input.email,
    note: input.note,
    uppercaseIdentifiers: event.uppercaseIdentifiers,
    identifierLabel: event.identifierLabel,
  });

  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  // Check duplicate identifier in this event excluding the attendee being edited
  const { data: conflict } = await supabase
    .from("attendees")
    .select("id, identifier")
    .eq("org_id", org.id)
    .eq("event_id", input.eventId)
    .neq("id", input.attendeeId)
    .ilike("identifier", validated.clean.identifier.replace(/[%_\\]/g, "\\$&"))
    .limit(1)
    .maybeSingle();

  if (conflict) {
    return {
      code: "DUPLICATE_IDENTIFIER",
      error: `Another attendee in this event already uses ${event.identifierLabel} "${conflict.identifier}".`,
    };
  }

  const { data: updated, error: updateErr } = await supabase
    .from("attendees")
    .update({
      identifier: validated.clean.identifier,
      full_name: validated.clean.fullName,
      email: validated.clean.email,
      note: validated.clean.note,
    })
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .select("id")
    .maybeSingle();

  if (updateErr || !updated) {
    if (updateErr?.code === "23505") {
      return {
        code: "DUPLICATE_IDENTIFIER",
        error: `Another attendee in this event already uses ${event.identifierLabel} "${validated.clean.identifier}".`,
      };
    }
    return { error: sanitizeClientErrorMessage(updateErr, "Attendee not found.") };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.updated",
      details: {
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        identifier: validated.clean.identifier,
        full_name: validated.clean.fullName,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for attendee.updated:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, attendeeId: input.attendeeId };
}

/**
 * Deletes a single attendee and writes to audit_log.
 */
export async function deleteAttendeeAction(input: {
  eventId: string;
  attendeeId: string;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const delParsed = DeleteAttendeeInputSchema.safeParse(input);
  if (!delParsed.success) {
    return { error: formatZodError(delParsed.error), code: "VALIDATION_ERROR" };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: existing } = await supabase
    .from("attendees")
    .select("id, identifier, full_name")
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!existing) {
    return { error: "Attendee not found.", code: "NOT_FOUND" };
  }

  const { error: delErr } = await supabase
    .from("attendees")
    .delete()
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id);

  if (delErr) {
    return { error: sanitizeClientErrorMessage(delErr, "Failed to delete attendee.") };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.deleted",
      details: {
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        identifier: existing.identifier,
        full_name: existing.full_name,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for attendee.deleted:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, affectedCount: 1 };
}

/**
 * Bulk-deletes selected attendees in an event and writes to audit_log.
 */
export async function bulkDeleteAttendeesAction(input: {
  eventId: string;
  attendeeIds: string[];
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const bulkDelParsed = BulkDeleteAttendeesInputSchema.safeParse(input);
  if (!bulkDelParsed.success) {
    return {
      error: formatZodError(bulkDelParsed.error),
      code: "VALIDATION_ERROR",
    };
  }
  const uniqueIds = Array.from(new Set(bulkDelParsed.data.attendeeIds));

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: deletedRows, error: delErr } = await supabase
    .from("attendees")
    .delete()
    .eq("org_id", org.id)
    .eq("event_id", input.eventId)
    .in("id", uniqueIds)
    .select("id");

  if (delErr) {
    return {
      error: sanitizeClientErrorMessage(delErr, "Failed to delete selected attendees."),
    };
  }

  const count = deletedRows?.length ?? 0;

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.bulk_deleted",
      details: {
        event_id: input.eventId,
        deleted_count: count,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for attendee.bulk_deleted:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, affectedCount: count };
}

/**
 * Assigns or unassigns a single certificate type for an attendee (checkbox per type).
 * Enforces plan limits server-side when assigning, and writes to audit_log.
 */
export async function setAttendeeCertificateTypeAction(input: {
  eventId: string;
  attendeeId: string;
  certificateTypeId: string;
  assigned: boolean;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const setParsed = SetAttendeeCertTypeInputSchema.safeParse(input);
  if (!setParsed.success) {
    return { error: formatZodError(setParsed.error), code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  // Verify attendee and certificate_type both belong to (org.id, eventId)
  const [attRes, typeRes, existingCertRes] = await Promise.all([
    supabase
      .from("attendees")
      .select("id, identifier")
      .eq("id", input.attendeeId)
      .eq("event_id", input.eventId)
      .eq("org_id", org.id)
      .maybeSingle(),
    supabase
      .from("certificate_types")
      .select("id, label")
      .eq("id", input.certificateTypeId)
      .eq("event_id", input.eventId)
      .eq("org_id", org.id)
      .maybeSingle(),
    supabase
      .from("attendee_certificates")
      .select("id")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId)
      .eq("attendee_id", input.attendeeId)
      .eq("certificate_type_id", input.certificateTypeId)
      .maybeSingle(),
  ]);

  if (!attRes.data || !typeRes.data) {
    return { error: "Attendee or certificate type not found.", code: "NOT_FOUND" };
  }

  if (input.assigned) {
    if (existingCertRes.data) {
      return { success: true, affectedCount: 0 };
    }

    const quota = await enforceAttendeePlan(org.id, input.eventId, 1, false);
    if (!quota.ok) {
      return { error: quota.error, code: quota.code };
    }

    const { error: insErr } = await supabase
      .from("attendee_certificates")
      .insert({
        org_id: org.id,
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        certificate_type_id: input.certificateTypeId,
      });

    if (insErr && insErr.code !== "23505") {
      return {
        error: sanitizeClientErrorMessage(insErr, "Failed to assign certificate type."),
      };
    }

    try {
      await admin.from("audit_log").insert({
        org_id: org.id,
        user_id: user.id,
        action: "attendee.certificate_assigned",
        details: {
          event_id: input.eventId,
          attendee_id: input.attendeeId,
          identifier: attRes.data.identifier,
          certificate_type_id: input.certificateTypeId,
          certificate_type_label: typeRes.data.label,
        },
      });
    } catch (err) {
      console.error("Failed to write audit_log for certificate_assigned:", err);
    }

    revalidatePath(`/dashboard/events/${input.eventId}`);
    return { success: true, affectedCount: 1 };
  }

  // Unassign
  const unassignGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!unassignGuard.ok) {
    return { error: unassignGuard.error, code: unassignGuard.code };
  }

  if (!existingCertRes.data) {
    return { success: true, affectedCount: 0 };
  }

  const { error: delErr } = await supabase
    .from("attendee_certificates")
    .delete()
    .eq("id", existingCertRes.data.id)
    .eq("org_id", org.id)
    .eq("event_id", input.eventId);

  if (delErr) {
    return {
      error: sanitizeClientErrorMessage(delErr, "Failed to unassign certificate type."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.certificate_unassigned",
      details: {
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        identifier: attRes.data.identifier,
        certificate_type_id: input.certificateTypeId,
        certificate_type_label: typeRes.data.label,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for certificate_unassigned:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, affectedCount: 1 };
}

/**
 * Bulk-assigns (or bulk-unassigns) a certificate type across selected attendee rows.
 * Only counts newly assigned rows against plan limits, and writes to audit_log.
 */
export async function bulkSetCertificateTypeAction(input: {
  eventId: string;
  attendeeIds: string[];
  certificateTypeId: string;
  assigned: boolean;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const bulkSetParsed = BulkSetCertTypeInputSchema.safeParse(input);
  if (!bulkSetParsed.success) {
    return {
      error: formatZodError(bulkSetParsed.error),
      code: "VALIDATION_ERROR",
    };
  }
  const uniqueIds = Array.from(new Set(bulkSetParsed.data.attendeeIds));

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const [validAttendeesRes, certTypeRes, existingLinksRes] = await Promise.all([
    supabase
      .from("attendees")
      .select("id")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId)
      .in("id", uniqueIds),
    supabase
      .from("certificate_types")
      .select("id, label")
      .eq("id", input.certificateTypeId)
      .eq("event_id", input.eventId)
      .eq("org_id", org.id)
      .maybeSingle(),
    supabase
      .from("attendee_certificates")
      .select("attendee_id")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId)
      .eq("certificate_type_id", input.certificateTypeId)
      .in("attendee_id", uniqueIds),
  ]);

  if (!certTypeRes.data) {
    return { error: "Certificate type not found.", code: "NOT_FOUND" };
  }

  const validAttendeeIds = (validAttendeesRes.data ?? []).map(
    (r) => r.id as string,
  );
  if (validAttendeeIds.length === 0) {
    return { error: "Selected attendees not found.", code: "NOT_FOUND" };
  }

  const alreadyLinkedSet = new Set(
    (existingLinksRes.data ?? []).map((r) => r.attendee_id as string),
  );

  if (input.assigned) {
    const toInsertIds = validAttendeeIds.filter(
      (id) => !alreadyLinkedSet.has(id),
    );

    if (toInsertIds.length === 0) {
      return { success: true, affectedCount: 0 };
    }

    const quota = await enforceAttendeePlan(
      org.id,
      input.eventId,
      toInsertIds.length,
      false,
    );

    if (!quota.ok) {
      return { error: quota.error, code: quota.code };
    }

    const rows = toInsertIds.map((attendeeId) => ({
      org_id: org.id,
      event_id: input.eventId,
      attendee_id: attendeeId,
      certificate_type_id: input.certificateTypeId,
    }));

    const { error: insErr } = await supabase
      .from("attendee_certificates")
      .insert(rows);

    if (insErr) {
      return {
        error: sanitizeClientErrorMessage(
          insErr,
          "Failed to bulk-assign certificate type.",
        ),
      };
    }

    try {
      await admin.from("audit_log").insert({
        org_id: org.id,
        user_id: user.id,
        action: "attendee.certificates_bulk_assigned",
        details: {
          event_id: input.eventId,
          certificate_type_id: input.certificateTypeId,
          certificate_type_label: certTypeRes.data.label,
          assigned_count: toInsertIds.length,
          skipped_existing: validAttendeeIds.length - toInsertIds.length,
        },
      });
    } catch (err) {
      console.error("Failed to write audit_log for bulk_assigned:", err);
    }

    revalidatePath(`/dashboard/events/${input.eventId}`);
    return { success: true, affectedCount: toInsertIds.length };
  }

  // Bulk unassign
  const bulkUnassignGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!bulkUnassignGuard.ok) {
    return { error: bulkUnassignGuard.error, code: bulkUnassignGuard.code };
  }

  const { data: deleted, error: delErr } = await supabase
    .from("attendee_certificates")
    .delete()
    .eq("org_id", org.id)
    .eq("event_id", input.eventId)
    .eq("certificate_type_id", input.certificateTypeId)
    .in("attendee_id", validAttendeeIds)
    .select("id");

  if (delErr) {
    return {
      error: sanitizeClientErrorMessage(
        delErr,
        "Failed to bulk-unassign certificate type.",
      ),
    };
  }

  const removedCount = deleted?.length ?? 0;

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.certificates_bulk_unassigned",
      details: {
        event_id: input.eventId,
        certificate_type_id: input.certificateTypeId,
        certificate_type_label: certTypeRes.data.label,
        unassigned_count: removedCount,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for bulk_unassigned:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, affectedCount: removedCount };
}

/**
 * Resets download_count (and timestamps) back to 0 for an attendee's certificates
 * in this event so they can download again when download_limit was reached.
 * Writes `attendee.downloads_reset` to audit_log.
 */
export async function resetAttendeeDownloadsAction(input: {
  eventId: string;
  attendeeId: string;
  attendeeCertificateId?: string;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const resetParsed = ResetAttendeeDownloadsInputSchema.safeParse(input);
  if (!resetParsed.success) {
    return { error: formatZodError(resetParsed.error), code: "VALIDATION_ERROR" };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: att } = await supabase
    .from("attendees")
    .select("id, identifier, full_name")
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!att) {
    return { error: "Attendee not found.", code: "NOT_FOUND" };
  }

  let query = supabase
    .from("attendee_certificates")
    .update({
      download_count: 0,
      first_downloaded_at: null,
      last_downloaded_at: null,
    })
    .eq("org_id", org.id)
    .eq("event_id", input.eventId)
    .eq("attendee_id", input.attendeeId);

  if (input.attendeeCertificateId) {
    query = query.eq("id", input.attendeeCertificateId);
  }

  const { data: resetRows, error: resetErr } = await query.select("id");
  if (resetErr) {
    return {
      error: sanitizeClientErrorMessage(resetErr, "Failed to reset download count."),
    };
  }

  const resetCount = resetRows?.length ?? 0;

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.downloads_reset",
      details: {
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        identifier: att.identifier,
        attendee_certificate_id: input.attendeeCertificateId ?? null,
        reset_certificates_count: resetCount,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for downloads_reset:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, affectedCount: resetCount };
}

/**
 * Updates the "Issues" / name-correction note field (`attendees.issue_note`)
 * so admins can record why an attendee's name or certificate was corrected.
 * Writes `attendee.issue_note_updated` to `audit_log`.
 */
export async function saveAttendeeIssueNoteAction(input: {
  eventId: string;
  attendeeId: string;
  issueNote: string;
}): Promise<AttendeeActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const writeGuard = await enforceWriteAccess(org.id, input.eventId);
  if (!writeGuard.ok) {
    return { error: writeGuard.error, code: writeGuard.code };
  }

  const issueParsed = SaveAttendeeIssueNoteInputSchema.safeParse(input);
  if (!issueParsed.success) {
    return {
      error: formatZodError(issueParsed.error),
      code: "VALIDATION_ERROR",
    };
  }
  const cleanIssue = issueParsed.data.issueNote.trim();

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: existing } = await supabase
    .from("attendees")
    .select("id, identifier, full_name, note")
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!existing) {
    return { error: "Attendee not found.", code: "NOT_FOUND" };
  }

  let { error: updateErr } = await supabase
    .from("attendees")
    .update({
      issue_note: cleanIssue ? cleanIssue : null,
    })
    .eq("id", input.attendeeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id);

  // Graceful fallback to `note` if 010_attendee_issue_note.sql hasn't been run in Supabase yet
  if (updateErr && /issue_note/i.test(updateErr.message)) {
    const fallback = await supabase
      .from("attendees")
      .update({
        note: cleanIssue ? `[Issue] ${cleanIssue}` : existing.note,
      })
      .eq("id", input.attendeeId)
      .eq("event_id", input.eventId)
      .eq("org_id", org.id);
    updateErr = fallback.error;
  }

  if (updateErr) {
    return {
      error: sanitizeClientErrorMessage(updateErr, "Failed to save issue note."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "attendee.issue_note_updated",
      details: {
        event_id: input.eventId,
        attendee_id: input.attendeeId,
        identifier: existing.identifier,
        full_name: existing.full_name,
        issue_note: cleanIssue || null,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for issue_note_updated:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, attendeeId: input.attendeeId };
}
