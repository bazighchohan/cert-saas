"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateAttendeeFields } from "@/lib/attendee-validation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AttendeeActionResult {
  success?: boolean;
  error?: string;
  code?:
    | "PLAN_LIMIT_REACHED"
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
 * Enforces both `plans.max_certificates_per_event` and `plans.max_certificates_total`
 * server-side before creating new attendee certificate records (or new attendees).
 */
async function enforceCertificateQuota(params: {
  supabase: SupabaseClient;
  orgId: string;
  planId: string;
  eventId: string;
  newCertificatesCount: number;
  addingNewAttendee?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    supabase,
    orgId,
    planId,
    eventId,
    newCertificatesCount,
    addingNewAttendee = false,
  } = params;

  const [planRes, eventCertsRes, orgCertsRes, eventAttendeesRes] =
    await Promise.all([
      supabase.from("plans").select("*").eq("id", planId).maybeSingle(),
      supabase
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("event_id", eventId),
      supabase
        .from("attendee_certificates")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId),
      addingNewAttendee
        ? supabase
            .from("attendees")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("event_id", eventId)
        : Promise.resolve({ count: 0 }),
    ]);

  const plan = planRes.data as Record<string, unknown> | null;
  const planName = (plan?.name as string) || planId;
  const maxPerEvent =
    plan?.max_certificates_per_event === undefined
      ? 50
      : ((plan.max_certificates_per_event as number | null) ?? null);
  const maxTotal =
    plan?.max_certificates_total === undefined
      ? 50
      : ((plan.max_certificates_total as number | null) ?? null);

  const eventCertsUsed = eventCertsRes.count ?? 0;
  const orgCertsUsed = orgCertsRes.count ?? 0;
  const eventAttendeesUsed = eventAttendeesRes.count ?? 0;

  if (newCertificatesCount > 0) {
    if (
      maxPerEvent !== null &&
      eventCertsUsed + newCertificatesCount > maxPerEvent
    ) {
      return {
        ok: false,
        error: `Plan limit reached: issuing ${newCertificatesCount} more certificate${
          newCertificatesCount === 1 ? "" : "s"
        } would exceed the ${planName} plan limit of ${maxPerEvent} certificates per event (${eventCertsUsed}/${maxPerEvent} used). Upgrade your plan in Billing.`,
      };
    }

    if (
      maxTotal !== null &&
      orgCertsUsed + newCertificatesCount > maxTotal
    ) {
      return {
        ok: false,
        error: `Plan limit reached: issuing ${newCertificatesCount} more certificate${
          newCertificatesCount === 1 ? "" : "s"
        } would exceed the ${planName} plan total limit of ${maxTotal} certificates across all events (${orgCertsUsed}/${maxTotal} used). Upgrade your plan in Billing.`,
      };
    }
  }

  // Also cap raw attendee rows per event at max_certificates_per_event so limits
  // cannot be bypassed by adding attendees with 0 certificate types checked.
  if (addingNewAttendee && maxPerEvent !== null && eventAttendeesUsed + 1 > maxPerEvent) {
    return {
      ok: false,
      error: `Plan limit reached: this event already has ${eventAttendeesUsed}/${maxPerEvent} attendees allowed on the ${planName} plan. Upgrade your plan in Billing to add more attendees.`,
    };
  }

  if (
    addingNewAttendee &&
    newCertificatesCount === 0 &&
    maxTotal !== null &&
    orgCertsUsed + 1 > maxTotal
  ) {
    return {
      ok: false,
      error: `Plan limit reached: your organization has already used ${orgCertsUsed}/${maxTotal} total certificates on the ${planName} plan. Upgrade your plan in Billing.`,
    };
  }

  return { ok: true };
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

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const event = await loadScopedEvent(supabase, org.id, input.eventId);
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

  // Enforce plan limits (max_certificates_per_event & max_certificates_total)
  const quota = await enforceCertificateQuota({
    supabase,
    orgId: org.id,
    planId: org.planId,
    eventId: input.eventId,
    newCertificatesCount: validTypeIds.length,
    addingNewAttendee: true,
  });

  if (!quota.ok) {
    return { error: quota.error, code: "PLAN_LIMIT_REACHED" };
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
    return { error: insertErr?.message || "Failed to add attendee." };
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
      return { error: `Failed to assign certificate(s): ${certErr.message}` };
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

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const event = await loadScopedEvent(supabase, org.id, input.eventId);
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
    return { error: updateErr?.message || "Attendee not found." };
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
    return { error: delErr.message || "Failed to delete attendee." };
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

  const uniqueIds = Array.from(new Set(input.attendeeIds)).filter(Boolean);
  if (uniqueIds.length === 0) {
    return { error: "No attendees selected.", code: "VALIDATION_ERROR" };
  }

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
    return { error: delErr.message || "Failed to delete selected attendees." };
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

    const quota = await enforceCertificateQuota({
      supabase,
      orgId: org.id,
      planId: org.planId,
      eventId: input.eventId,
      newCertificatesCount: 1,
    });

    if (!quota.ok) {
      return { error: quota.error, code: "PLAN_LIMIT_REACHED" };
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
      return { error: insErr.message || "Failed to assign certificate type." };
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
    return { error: delErr.message || "Failed to unassign certificate type." };
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

  const uniqueIds = Array.from(new Set(input.attendeeIds)).filter(Boolean);
  if (uniqueIds.length === 0) {
    return { error: "No attendees selected.", code: "VALIDATION_ERROR" };
  }

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

    const quota = await enforceCertificateQuota({
      supabase,
      orgId: org.id,
      planId: org.planId,
      eventId: input.eventId,
      newCertificatesCount: toInsertIds.length,
    });

    if (!quota.ok) {
      return { error: quota.error, code: "PLAN_LIMIT_REACHED" };
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
        error: insErr.message || "Failed to bulk-assign certificate type.",
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
      error: delErr.message || "Failed to bulk-unassign certificate type.",
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
    return { error: resetErr.message || "Failed to reset download count." };
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
