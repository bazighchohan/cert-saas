"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { validateEventSlug } from "@/lib/event-validation";
import {
  assertWithinPlan,
  isPlanEnforcementError,
} from "@/lib/plan-enforcement";
import {
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
    | "PLAN_LIMIT_REACHED"
    | "PLAN_EXPIRED"
    | "ORG_SUSPENDED"
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

/**
 * Creates a new event for getCurrentOrg().
 * Enforces plan.max_events server-side, checks global slug uniqueness,
 * creates a default 'participation' certificate_type, and writes to audit_log.
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

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  // 1. Central plan & expiration enforcement (max_events + read-only check).
  try {
    await assertWithinPlan(org.id, "event");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return {
        code: err.code,
        error: err.message,
      };
    }
    throw err;
  }

  // 2. Check global slug uniqueness across all tenants (admin client because RLS hides other orgs' events).
  const { data: existingSlug } = await admin
    .from("events")
    .select("id")
    .eq("slug", validated.clean.slug)
    .maybeSingle();

  if (existingSlug) {
    return {
      code: "SLUG_TAKEN",
      error: `The URL slug "${validated.clean.slug}" is already taken. Please choose a different slug.`,
    };
  }

  // 3. Insert the event scoped to org.id.
  const { data: created, error: insertErr } = await supabase
    .from("events")
    .insert({
      org_id: org.id,
      ...validated.clean,
    })
    .select("id, slug, title")
    .maybeSingle();

  if (insertErr || !created) {
    if (insertErr?.code === "23505") {
      return {
        code: "SLUG_TAKEN",
        error: `The URL slug "${validated.clean.slug}" is already taken. Please choose a different slug.`,
      };
    }
    return {
      error: sanitizeClientErrorMessage(insertErr, "Failed to create event."),
    };
  }

  const eventId = created.id as string;

  // 4. Create a default 'participation' certificate type for the event.
  await supabase.from("certificate_types").insert({
    org_id: org.id,
    event_id: eventId,
    key: "participation",
    label: "Certificate of Participation",
  });

  // 5. Write audit_log entry.
  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "event.created",
      details: {
        event_id: eventId,
        title: validated.clean.title,
        slug: validated.clean.slug,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for event.created:", err);
  }

  revalidatePath("/dashboard", "layout");
  return {
    success: true,
    eventId,
    slug: created.slug as string,
  };
}

/**
 * Updates event overview details (title, subtitle, slug, date, contact info).
 * Scoped strictly to getCurrentOrg(). Writes event.updated to audit_log.
 */
export async function updateEventOverviewAction(
  input: UpdateEventOverviewInput,
): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to update an event." };
  }

  try {
    await assertWithinPlan(org.id, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const ovParsed = UpdateEventOverviewSchema.safeParse(input);
  if (!ovParsed.success) {
    return { error: formatZodError(ovParsed.error), code: "VALIDATION_ERROR" };
  }

  const validated = validateCommonDetails(ovParsed.data);
  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  // Verify the event belongs to org.id.
  const { data: currentEvent } = await supabase
    .from("events")
    .select("id, slug, title")
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!currentEvent) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  // If slug changed, check global uniqueness across all tenants.
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
 * Updates event Settings tab fields: released toggle, identifier_label,
 * require_name_match toggle, and download_limit (1, 3, or null = unlimited).
 * Scoped strictly to getCurrentOrg(). Writes event.updated to audit_log.
 */
export async function updateEventSettingsAction(
  input: UpdateEventSettingsInput,
): Promise<EventActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to update event settings." };
  }

  try {
    await assertWithinPlan(org.id, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const settingsParsed = UpdateEventSettingsSchema.safeParse(input);
  if (!settingsParsed.success) {
    return {
      error: formatZodError(settingsParsed.error),
      code: "VALIDATION_ERROR",
    };
  }

  const identifierLabel = settingsParsed.data.identifierLabel;

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: currentEvent } = await supabase
    .from("events")
    .select("id, slug, released")
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

  const basePayload: Record<string, unknown> = {
    released: Boolean(input.released),
    identifier_label: identifierLabel,
    require_name_match: Boolean(input.requireNameMatch),
    download_limit: input.downloadLimit,
  };

  const extendedPayload: Record<string, unknown> = {
    ...basePayload,
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

  // Graceful fallback if 006 / 007 optional columns haven't been applied in Supabase yet
  if (updateErr && /show_qr|qr_position|uppercase_identifiers/i.test(updateErr.message)) {
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
        previous_released: Boolean(currentEvent.released),
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
  return {
    success: true,
    eventId: input.eventId,
    slug: updated.slug as string,
  };
}

/**
 * Deletes an event after verifying typed confirmation (must match the event slug).
 * Removes any template files in Storage, deletes the event (cascading attendees,
 * attendee_certificates, certificate_types, and download_log), and writes to audit_log.
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

  try {
    await assertWithinPlan(org.id, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const delParsed = DeleteEventSchema.safeParse(input);
  if (!delParsed.success) {
    return {
      code: "VALIDATION_ERROR",
      error: formatZodError(delParsed.error),
    };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: event } = await supabase
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

  // 1. Collect any template files associated with this event and remove them from Storage.
  const { data: certTypes } = await supabase
    .from("certificate_types")
    .select("template_path")
    .eq("org_id", org.id)
    .eq("event_id", input.eventId);

  const templatePaths = (certTypes ?? [])
    .map((c) => c.template_path as string | null)
    .filter((p): p is string => Boolean(p && p.startsWith(`${org.id}/`)));

  if (templatePaths.length > 0) {
    try {
      await admin.storage.from("templates").remove(templatePaths);
    } catch {
      // Bucket may not exist yet prior to the storage phase.
    }
  }

  // 2. Delete the event (cascades to certificate_types, attendees, attendee_certificates, download_log).
  const { error: delErr } = await supabase
    .from("events")
    .delete()
    .eq("id", input.eventId)
    .eq("org_id", org.id);

  if (delErr) {
    return { error: sanitizeClientErrorMessage(delErr, "Failed to delete event.") };
  }

  // 3. Write audit_log entry.
  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "event.deleted",
      details: {
        event_id: input.eventId,
        title: event.title,
        slug: event.slug,
        removed_templates: templatePaths.length,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for event.deleted:", err);
  }

  revalidatePath("/dashboard", "layout");
  return { success: true };
}
