"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { validateEventSlug } from "@/lib/event-validation";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface EventActionResult {
  success?: boolean;
  error?: string;
  code?: "PLAN_LIMIT_REACHED" | "SLUG_TAKEN" | "VALIDATION_ERROR" | "NOT_FOUND";
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

  const validated = validateCommonDetails(input);
  if (validated.error || !validated.clean) {
    return { error: validated.error, code: "VALIDATION_ERROR" };
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  // 1. Enforce plan limit max_events server-side.
  const [planRes, countRes] = await Promise.all([
    supabase
      .from("plans")
      .select("id, name, max_events")
      .eq("id", org.planId)
      .maybeSingle(),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);

  const maxEvents =
    planRes.data?.max_events === undefined
      ? 1
      : (planRes.data.max_events as number | null);
  const planName = (planRes.data?.name as string) || org.planId;
  const currentEvents = countRes.count ?? 0;

  if (maxEvents !== null && currentEvents >= maxEvents) {
    return {
      code: "PLAN_LIMIT_REACHED",
      error: `Your organization has reached the ${planName} plan limit of ${maxEvents} event${
        maxEvents === 1 ? "" : "s"
      } (${currentEvents}/${maxEvents} used). Upgrade your plan in Billing to create more events.`,
    };
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
      error: insertErr?.message || "Failed to create event.",
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

  const validated = validateCommonDetails(input);
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
    return { error: updateErr?.message || "Failed to update event." };
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

  const identifierLabel = input.identifierLabel.trim();
  if (identifierLabel.length < 1 || identifierLabel.length > 60) {
    return {
      error: "Identifier label must be between 1 and 60 characters.",
      code: "VALIDATION_ERROR",
    };
  }

  const allowedLimits = new Set<number | null>([1, 3, null]);
  if (!allowedLimits.has(input.downloadLimit)) {
    return {
      error: "Download limit must be 1, 3, or Unlimited.",
      code: "VALIDATION_ERROR",
    };
  }

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

  // Graceful fallback if 006_event_qr_settings.sql hasn't been applied in Supabase yet
  if (updateErr && /show_qr|qr_position/i.test(updateErr.message)) {
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
    return { error: updateErr?.message || "Failed to save event settings." };
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

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: event } = await supabase
    .from("events")
    .select("id, title, slug")
    .eq("id", input.eventId)
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
    return { error: delErr.message || "Failed to delete event." };
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
