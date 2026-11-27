"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import {
  executeEventDataPurge,
  filterSafeOrgPaths,
} from "@/lib/data-deletion";
import { validateEventSlug } from "@/lib/event-validation";
import {
  assertWithinPlan,
  isPlanEnforcementError,
  type PlanErrorCode,
} from "@/lib/plan-enforcement";
import {
  DeleteEventDataSchema,
  DeleteEventSchema,
  EventDetailsInputSchema,
  UpdateEventOverviewSchema,
  UpdateEventSettingsSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface EventActionResult {
  success?: boolean;
  error?: string;
  code?:
  | PlanErrorCode
  | "SLUG_TAKEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND";
  eventId?: string;
  slug?: string;
}

export interface CreateEventInput {
  title: string;
  subtitle?: string;
  slug: string;
  eventDate?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface UpdateEventOverviewInput {
  eventId: string;
  title: string;
  subtitle?: string;
  slug: string;
  eventDate?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface UpdateEventSettingsInput {
  eventId: string;
  released: boolean;
  identifierLabel: string;
  uppercaseIdentifiers?: boolean;
  requireNameMatch: boolean;
  downloadLimit: number | null;
  showQr?: boolean;
  qrPosition?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "custom";
}

function addMonthsUtcIso(months: number, fromDate = new Date()): string {
  const d = new Date(fromDate.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

function validateCommonDetails(input: {
  title: string;
  subtitle?: string;
  slug: string;
  eventDate?: string;
  contactEmail?: string;
  contactPhone?: string;
}): {
  error?: string;
  clean?: {
    title: string;
    subtitle: string | null;
    slug: string;
    event_date: string | null;
    contact_email: string | null;
    contact_phone: string | null;
  };
} {
  const title = input.title.trim();
  if (title.length < 2 || title.length > 200) {
    return { error: "Event title must be between 2 and 200 characters." };
  }

  const subtitle = input.subtitle?.trim() ? input.subtitle.trim() : null;
  if (subtitle && subtitle.length > 300) {
    return { error: "Subtitle cannot exceed 300 characters." };
  }

  const slugCheck = validateEventSlug(input.slug);
  if (!slugCheck.valid) {
    return { error: slugCheck.error };
  }

  const eventDate = input.eventDate?.trim() ? input.eventDate.trim() : null;
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    return { error: "Event date must be a valid YYYY-MM-DD date." };
  }

  const contactEmail = input.contactEmail?.trim()
    ? input.contactEmail.trim().toLowerCase()
    : null;
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return { error: "Please enter a valid contact email address." };
  }

  const contactPhone = input.contactPhone?.trim()
    ? input.contactPhone.trim()
    : null;
  if (contactPhone && contactPhone.length > 40) {
    return { error: "Contact phone cannot exceed 40 characters." };
  }

  return {
    clean: {
      title,
      subtitle,
      slug: slugCheck.slug,
      event_date: eventDate,
      contact_email: contactEmail,
      contact_phone: contactPhone,
    },
  };
}

function mapSlotRpcError(rawMessage: string): {
  code?: EventActionResult["code"];
  error: string;
} {
  if (rawMessage.includes("PURCHASE_PENDING")) {
    return {
      code: "PURCHASE_PENDING",
      error:
        "Your package purchase is waiting for approval. You will be able to create events as soon as it is approved.",
    };
  }
  if (rawMessage.includes("NO_EVENT_SLOTS")) {
    return {
      code: "NO_EVENT_SLOTS",
      error:
        "No event slots left in your active package(s). Buy another package in Billing to create more events.",
    };
  }
  if (rawMessage.includes("PURCHASE_EXPIRED")) {
    return {
      code: "PURCHASE_EXPIRED",
      error:
        "Your package has expired — buy a package in Billing to create new events.",
    };
  }
  if (rawMessage.includes("NO_ACTIVE_PURCHASE")) {
    return {
      code: "NO_ACTIVE_PURCHASE",
      error: "Please buy a package in Billing before creating an event.",
    };
  }
  if (rawMessage.includes("ORG_SUSPENDED")) {
    return {
      code: "ORG_SUSPENDED",
      error: "Your organization account is suspended.",
    };
  }
  if (rawMessage.includes("SLUG_TAKEN") || rawMessage.includes("23505")) {
    return {
      code: "SLUG_TAKEN",
      error: "That URL slug is already taken. Please choose a different slug.",
    };
  }
  return {
    error: "Failed to create event. Please try again.",
  };
}

/**
 * Creates a new event for `getCurrentOrg()` inside a single database transaction
 * (`create_event_consuming_slot`), consuming 1 slot from the soonest-expiring
 * active purchase, copying `max_certificates` from it, creating the default
 * `participation` certificate_type, and logging `event.created` to `audit_log`.
 */
export async function createEventAction(
  input: CreateEventInput,
): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to create an event." };
  }

  const zodParsed = EventDetailsInputSchema.safeParse(input);
  if (!zodParsed.success) {
    return { error: formatZodError(zodParsed.error), code: "VALIDATION_ERROR" };
  }

  const validated = validateCommonDetails(zodParsed.data);
  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  // 1. Pre-check via central assertWithinPlan(orgId, eventId, action)
  try {
    await assertWithinPlan(org.id, null, "create_event");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return {
        code: err.code,
        error: err.message,
      };
    }
    throw err;
  }

  const admin = getSupabaseAdmin();

  // 2. Atomic transactional slot consumption + event creation via SQL RPC
  const { data: rpcRows, error: rpcErr } = await admin.rpc(
    "create_event_consuming_slot",
    {
      p_org_id: org.id,
      p_user_id: user.id,
      p_title: validated.clean.title,
      p_subtitle: validated.clean.subtitle,
      p_slug: validated.clean.slug,
      p_event_date: validated.clean.event_date,
      p_contact_email: validated.clean.contact_email,
      p_contact_phone: validated.clean.contact_phone,
      p_released: false,
    },
  );

  if (rpcErr) {
    if (rpcErr.code === "23505") {
      return {
        code: "SLUG_TAKEN",
        error: `The URL slug "${validated.clean.slug}" is already taken. Please choose a different slug.`,
      };
    }
    const mapped = mapSlotRpcError(rpcErr.message || "");
    return mapped;
  }

  const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { event_id?: string; slug?: string }
    | undefined;

  if (!row?.event_id) {
    return { error: "Failed to create event." };
  }

  revalidatePath("/dashboard", "layout");
  revalidatePath("/dashboard/billing");
  return {
    success: true,
    eventId: row.event_id,
    slug: row.slug || validated.clean.slug,
  };
}

/**
 * Updates event overview details (title, subtitle, slug, date, contact info).
 * Scoped strictly to `getCurrentOrg()`. Writes `event.updated` to `audit_log`.
 */
export async function updateEventOverviewAction(
  input: UpdateEventOverviewInput,
): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to update an event." };
  }

  const ovParsed = UpdateEventOverviewSchema.safeParse(input);
  if (!ovParsed.success) {
    return { error: formatZodError(ovParsed.error), code: "VALIDATION_ERROR" };
  }

  try {
    await assertWithinPlan(org.id, ovParsed.data.eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const validated = validateCommonDetails(ovParsed.data);
  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: currentEvent } = await supabase
    .from("events")
    .select("id, slug, title")
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!currentEvent) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  if (validated.clean.slug !== currentEvent.slug) {
    const { data: slugConflict } = await admin
      .from("events")
      .select("id")
      .eq("slug", validated.clean.slug)
      .neq("id", input.eventId)
      .maybeSingle();

    if (slugConflict) {
      return {
        code: "SLUG_TAKEN",
        error: `The URL slug "${validated.clean.slug}" is already taken. Please choose a different slug.`,
      };
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from("events")
    .update(validated.clean)
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .select("id, slug")
    .maybeSingle();

  if (updateErr || !updated) {
    if (updateErr?.code === "23505") {
      return {
        code: "SLUG_TAKEN",
        error: `The URL slug "${validated.clean.slug}" is already taken. Please choose a different slug.`,
      };
    }
    return { error: sanitizeClientErrorMessage(updateErr, "Failed to update event.") };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "event.updated",
      details: {
        event_id: input.eventId,
        section: "overview",
        title: validated.clean.title,
        slug: validated.clean.slug,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for event.updated:", err);
  }

  revalidatePath("/dashboard", "layout");
  revalidatePath(`/dashboard/events/${input.eventId}`);
  return {
    success: true,
    eventId: input.eventId,
    slug: updated.slug as string,
  };
}

/**
 * Updates event Settings tab fields (`released`, `identifier_label`,
 * `require_name_match`, `download_limit`, `show_qr`, `qr_position`).
 *
 * - Enforces `assertWithinPlan(org.id, eventId, "release_event")` when releasing
 *   so no event can be released without an approved, active purchase.
 * - Sets `retention_until` to 12 months after the event is released.
 */
export async function updateEventSettingsAction(
  input: UpdateEventSettingsInput,
): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to update event settings." };
  }

  const settingsParsed = UpdateEventSettingsSchema.safeParse(input);
  if (!settingsParsed.success) {
    return {
      error: formatZodError(settingsParsed.error),
      code: "VALIDATION_ERROR",
    };
  }

  try {
    await assertWithinPlan(
      org.id,
      settingsParsed.data.eventId,
      settingsParsed.data.released ? "release_event" : "write",
    );
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const identifierLabel = settingsParsed.data.identifierLabel;

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: currentEvent } = await supabase
    .from("events")
    .select("id, slug, released, retention_until")
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!currentEvent) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  const allowedPositions = new Set([
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
    "custom",
  ]);
  const qrPosition =
    input.qrPosition && allowedPositions.has(input.qrPosition)
      ? input.qrPosition
      : "bottom-right";

  // Set retention_until to 12 months after the event is released
  const wasReleased = Boolean(currentEvent.released);
  const existingRetention =
    typeof (currentEvent as Record<string, unknown>).retention_until === "string"
      ? ((currentEvent as Record<string, unknown>).retention_until as string)
      : null;

  const nextRetentionUntil =
    input.released && (!wasReleased || !existingRetention)
      ? addMonthsUtcIso(12)
      : existingRetention;

  const basePayload: Record<string, unknown> = {
    released: Boolean(input.released),
    identifier_label: identifierLabel,
    require_name_match: Boolean(input.requireNameMatch),
    download_limit: input.downloadLimit,
  };

  const extendedPayload: Record<string, unknown> = {
    ...basePayload,
    ...(nextRetentionUntil !== null
      ? { retention_until: nextRetentionUntil }
      : {}),
    ...(input.uppercaseIdentifiers !== undefined
      ? { uppercase_identifiers: Boolean(input.uppercaseIdentifiers) }
      : {}),
    ...(input.showQr !== undefined ? { show_qr: Boolean(input.showQr) } : {}),
    ...(input.qrPosition !== undefined ? { qr_position: qrPosition } : {}),
  };

  let { data: updated, error: updateErr } = await supabase
    .from("events")
    .update(extendedPayload)
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .select("id, slug")
    .maybeSingle();

  if (
    updateErr &&
    /show_qr|qr_position|uppercase_identifiers|retention_until/i.test(
      updateErr.message,
    )
  ) {
    const retry = await supabase
      .from("events")
      .update(basePayload)
      .eq("id", input.eventId)
      .eq("org_id", org.id)
      .select("id, slug")
      .maybeSingle();
    updated = retry.data;
    updateErr = retry.error;
  }

  if (updateErr || !updated) {
    return {
      error: sanitizeClientErrorMessage(updateErr, "Failed to save event settings."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "event.updated",
      details: {
        event_id: input.eventId,
        section: "settings",
        released: Boolean(input.released),
        previous_released: wasReleased,
        retention_until: nextRetentionUntil,
        identifier_label: identifierLabel,
        require_name_match: Boolean(input.requireNameMatch),
        download_limit: input.downloadLimit,
        show_qr: input.showQr,
        qr_position: qrPosition,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for event.updated (settings):", err);
  }

  revalidatePath("/dashboard", "layout");
  revalidatePath(`/dashboard/events/${input.eventId}`);
  revalidatePath(`/e/${updated.slug as string}`);
  return {
    success: true,
    eventId: input.eventId,
    slug: updated.slug as string,
  };
}

/**
 * Deletes an event's data (all attendees, issued certificates, uploaded template
 * files, top-up proof files, and download logs) while keeping the event shell.
 * Requires typed confirmation matching the event slug. Allowed even when a
 * package has expired so organizations always retain self-service erasure rights.
 */
export async function deleteEventDataAction(input: {
  eventId: string;
  confirmSlug: string;
}): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to delete event data." };
  }

  const parsed = DeleteEventDataSchema.safeParse(input);
  if (!parsed.success) {
    return {
      code: "VALIDATION_ERROR",
      error: formatZodError(parsed.error),
    };
  }

  const admin = getSupabaseAdmin();
  const { data: event } = await admin
    .from("events")
    .select("id, title, slug")
    .eq("id", parsed.data.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  if (parsed.data.confirmSlug.trim().toLowerCase() !== String(event.slug)) {
    return {
      code: "VALIDATION_ERROR",
      error: `Please type "${event.slug}" to confirm deleting this event's data.`,
    };
  }

  try {
    await executeEventDataPurge({
      orgId: org.id,
      eventId: parsed.data.eventId,
      actorUserId: user.id,
      adapter: {
        async getEventScopedPaths(orgId, eventId) {
          const [ctRes, topRes] = await Promise.all([
            admin
              .from("certificate_types")
              .select("template_path")
              .eq("org_id", orgId)
              .eq("event_id", eventId),
            admin
              .from("certificate_topups")
              .select("screenshot_path")
              .eq("org_id", orgId)
              .eq("event_id", eventId),
          ]);
          return {
            templatePaths: (ctRes.data ?? []).map(
              (r) => (r.template_path as string | null) ?? "",
            ),
            proofPaths: (topRes.data ?? []).map(
              (r) => (r.screenshot_path as string | null) ?? "",
            ),
          };
        },
        async removeStorageObjects(bucket, paths) {
          try {
            await admin.storage.from(bucket).remove(paths);
          } catch {
            // Non-fatal if bucket/object already absent
          }
        },
        async purgeEventRows(orgId, eventId, actorUserId) {
          // 1. Delete attendee_certificates (cascades download_log) & attendees
          await admin
            .from("attendee_certificates")
            .delete()
            .eq("org_id", orgId)
            .eq("event_id", eventId);

          const { count } = await admin
            .from("attendees")
            .delete({ count: "exact" })
            .eq("org_id", orgId)
            .eq("event_id", eventId);

          // 2. Clear uploaded template references on certificate_types & unrelease event
          await admin
            .from("certificate_types")
            .update({
              template_path: null,
              template_mime: null,
              page_width_pt: null,
              page_height_pt: null,
              page_count: 1,
              page_index: 0,
            })
            .eq("org_id", orgId)
            .eq("event_id", eventId);

          await admin
            .from("events")
            .update({ released: false, retention_until: null })
            .eq("id", eventId)
            .eq("org_id", orgId);

          // 3. Remove event-scoped audit logs & record minimal erasure entry
          await admin
            .from("audit_log")
            .delete()
            .eq("org_id", orgId)
            .contains("details", { event_id: eventId });

          await admin.from("audit_log").insert({
            org_id: orgId,
            user_id: actorUserId,
            action: "event.data_deleted",
            details: {
              event_id: eventId,
              slug: event.slug,
              attendees_deleted: count ?? 0,
            },
          });

          return { attendeesDeleted: count ?? 0 };
        },
        async getOrgScopedPaths() {
          return { templatePaths: [], proofPaths: [] };
        },
        async purgeOrganizationRows() {},
      },
    });
  } catch (err) {
    return {
      error: sanitizeClientErrorMessage(
        err,
        "Failed to delete this event's data.",
      ),
    };
  }

  revalidatePath("/dashboard", "layout");
  revalidatePath(`/dashboard/events/${parsed.data.eventId}`);
  revalidatePath(`/e/${event.slug as string}`);
  return {
    success: true,
    eventId: parsed.data.eventId,
    slug: event.slug as string,
  };
}

/**
 * Deletes an event after verifying typed confirmation (must match the event slug).
 */
export async function deleteEventAction(input: {
  eventId: string;
  confirmSlug: string;
}): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to delete an event." };
  }

  const delParsed = DeleteEventSchema.safeParse(input);
  if (!delParsed.success) {
    return {
      code: "VALIDATION_ERROR",
      error: formatZodError(delParsed.error),
    };
  }

  const admin = getSupabaseAdmin();

  const { data: event } = await admin
    .from("events")
    .select("id, title, slug")
    .eq("id", delParsed.data.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  if (input.confirmSlug.trim().toLowerCase() !== (event.slug as string)) {
    return {
      code: "VALIDATION_ERROR",
      error: `Please type "${event.slug}" to confirm deletion.`,
    };
  }

  const [ctRes, topRes] = await Promise.all([
    admin
      .from("certificate_types")
      .select("template_path")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId),
    admin
      .from("certificate_topups")
      .select("screenshot_path")
      .eq("org_id", org.id)
      .eq("event_id", input.eventId),
  ]);

  const templatePaths = filterSafeOrgPaths(
    org.id,
    (ctRes.data ?? []).map((c) => c.template_path as string | null),
  );
  const proofPaths = filterSafeOrgPaths(
    org.id,
    (topRes.data ?? []).map((t) => t.screenshot_path as string | null),
  );

  if (templatePaths.length > 0) {
    try {
      await admin.storage.from("templates").remove(templatePaths);
    } catch {
      // Bucket may not exist yet
    }
  }
  if (proofPaths.length > 0) {
    try {
      await admin.storage.from("payment-proofs").remove(proofPaths);
    } catch {
      // Bucket may not exist yet
    }
  }

  const { error: delErr } = await admin
    .from("events")
    .delete()
    .eq("id", input.eventId)
    .eq("org_id", org.id);

  if (delErr) {
    return {
      error: sanitizeClientErrorMessage(delErr, "Failed to delete event."),
    };
  }

  try {
    await admin
      .from("audit_log")
      .delete()
      .eq("org_id", org.id)
      .contains("details", { event_id: input.eventId });

    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "event.deleted",
      details: {
        event_id: input.eventId,
        slug: event.slug,
        removed_templates: templatePaths.length,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for event.deleted:", err);
  }

  revalidatePath("/dashboard", "layout");
  revalidatePath(`/e/${event.slug as string}`);
  return { success: true };
}
