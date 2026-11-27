"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { resolveCuratedFont } from "@/lib/fonts";
import {
  assertWithinPlan,
  isPlanEnforcementError,
  type PlanErrorCode,
} from "@/lib/plan-enforcement";
import {
  AddCertificateTypeSchema,
  DeleteCertificateTypeSchema,
  RenameCertificateTypeSchema,
  SaveNamePlacementSchema,
  SelectTemplatePageSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateAndInspectTemplate } from "@/lib/template-validator";

export interface TemplateActionResult {
  success?: boolean;
  error?: string;
  code?: PlanErrorCode | "VALIDATION_ERROR" | "NOT_FOUND";
  certTypeId?: string;
}

function slugifyTypeKey(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return base || "type";
}

/**
 * Adds a new certificate type (e.g. Participation, Appreciation, Winner) to an event.
 */
export async function addCertificateTypeAction(input: {
  eventId: string;
  label: string;
}): Promise<TemplateActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const addParsed = AddCertificateTypeSchema.safeParse(input);
  if (!addParsed.success) {
    return {
      error: formatZodError(addParsed.error),
      code: "VALIDATION_ERROR",
    };
  }
  const cleanLabel = addParsed.data.label;

  try {
    await assertWithinPlan(org.id, addParsed.data.eventId, {
      kind: "certificate_type",
      add: 1,
    });
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!event) {
    return { error: "Event not found.", code: "NOT_FOUND" };
  }

  const { data: existingData } = await supabase
    .from("certificate_types")
    .select("id, key")
    .eq("org_id", org.id)
    .eq("event_id", input.eventId);

  const existingTypes = existingData ?? [];
  const usedKeys = new Set(existingTypes.map((r) => r.key as string));
  const baseKey = slugifyTypeKey(cleanLabel);
  let key = baseKey;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${baseKey}-${suffix}`;
    suffix++;
  }

  const { data: created, error: insertErr } = await supabase
    .from("certificate_types")
    .insert({
      org_id: org.id,
      event_id: input.eventId,
      key,
      label: cleanLabel,
    })
    .select("id")
    .maybeSingle();

  if (insertErr || !created) {
    return {
      error: sanitizeClientErrorMessage(insertErr, "Failed to add certificate type."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "certificate_type.created",
      details: {
        event_id: input.eventId,
        certificate_type_id: created.id,
        key,
        label: cleanLabel,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for certificate_type.created:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, certTypeId: created.id as string };
}

/**
 * Renames an existing certificate type's label.
 */
export async function renameCertificateTypeAction(input: {
  eventId: string;
  certTypeId: string;
  label: string;
}): Promise<TemplateActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const renParsed = RenameCertificateTypeSchema.safeParse(input);
  if (!renParsed.success) {
    return {
      error: formatZodError(renParsed.error),
      code: "VALIDATION_ERROR",
    };
  }
  const cleanLabel = renParsed.data.label;

  try {
    await assertWithinPlan(org.id, renParsed.data.eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const supabase = await createSupabaseServerClient();
  const { data: updated, error } = await supabase
    .from("certificate_types")
    .update({ label: cleanLabel })
    .eq("id", input.certTypeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .select("id")
    .maybeSingle();

  if (error || !updated) {
    return {
      error: sanitizeClientErrorMessage(error, "Certificate type not found."),
    };
  }

  try {
    await getSupabaseAdmin()
      .from("audit_log")
      .insert({
        org_id: org.id,
        user_id: user.id,
        action: "certificate_type.renamed",
        details: {
          event_id: input.eventId,
          certificate_type_id: input.certTypeId,
          label: cleanLabel,
        },
      });
  } catch (err) {
    console.error("Failed to write audit_log for certificate_type.renamed:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, certTypeId: input.certTypeId };
}

/**
 * Selects a different page from a multi-page PDF template and updates
 * page_index, page_width_pt, and page_height_pt.
 */
export async function selectTemplatePageAction(input: {
  eventId: string;
  certTypeId: string;
  pageIndex: number;
}): Promise<TemplateActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const selParsed = SelectTemplatePageSchema.safeParse(input);
  if (!selParsed.success) {
    return { error: formatZodError(selParsed.error), code: "VALIDATION_ERROR" };
  }

  try {
    await assertWithinPlan(org.id, selParsed.data.eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: certType } = await supabase
    .from("certificate_types")
    .select("id, template_path, template_mime")
    .eq("id", selParsed.data.certTypeId)
    .eq("event_id", selParsed.data.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!certType || !certType.template_path) {
    return { error: "No uploaded template found for this certificate type." };
  }

  const path = certType.template_path as string;
  if (!path.startsWith(`${org.id}/${input.eventId}/`)) {
    return { error: "Invalid template storage path." };
  }

  const { data: blob, error: dlErr } = await admin.storage
    .from("templates")
    .download(path);

  if (dlErr || !blob) {
    return { error: "Could not load template file from Storage." };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const inspected = await validateAndInspectTemplate(
    bytes,
    "application/pdf",
    input.pageIndex,
  );

  if (!inspected.valid) {
    return { error: inspected.error || "Invalid page index." };
  }

  const { error: updateErr } = await supabase
    .from("certificate_types")
    .update({
      page_index: inspected.pageIndex,
      page_width_pt: inspected.pageWidthPt,
      page_height_pt: inspected.pageHeightPt,
      page_count: inspected.pageCount,
    })
    .eq("id", input.certTypeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id);

  if (updateErr) {
    return {
      error: sanitizeClientErrorMessage(updateErr, "Failed to update selected page."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "certificate_type.page_selected",
      details: {
        event_id: input.eventId,
        certificate_type_id: input.certTypeId,
        page_index: inspected.pageIndex,
        page_width_pt: inspected.pageWidthPt,
        page_height_pt: inspected.pageHeightPt,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for certificate_type.page_selected:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, certTypeId: input.certTypeId };
}

/**
 * Deletes a certificate type and removes its template file from Supabase Storage.
 */
export async function deleteCertificateTypeAction(input: {
  eventId: string;
  certTypeId: string;
}): Promise<TemplateActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const delParsed = DeleteCertificateTypeSchema.safeParse(input);
  if (!delParsed.success) {
    return { error: formatZodError(delParsed.error), code: "VALIDATION_ERROR" };
  }

  try {
    await assertWithinPlan(org.id, delParsed.data.eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: certType } = await supabase
    .from("certificate_types")
    .select("id, key, label, template_path")
    .eq("id", delParsed.data.certTypeId)
    .eq("event_id", delParsed.data.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!certType) {
    return { error: "Certificate type not found.", code: "NOT_FOUND" };
  }

  const templatePath = certType.template_path as string | null;
  if (templatePath && templatePath.startsWith(`${org.id}/${input.eventId}/`)) {
    try {
      await admin.storage.from("templates").remove([templatePath]);
    } catch {
      // Ignore if file already missing
    }
  }

  const { error: delErr } = await supabase
    .from("certificate_types")
    .delete()
    .eq("id", input.certTypeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id);

  if (delErr) {
    return {
      error: sanitizeClientErrorMessage(delErr, "Failed to delete certificate type."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "certificate_type.deleted",
      details: {
        event_id: input.eventId,
        certificate_type_id: input.certTypeId,
        key: certType.key,
        label: certType.label,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for certificate_type.deleted:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true };
}

export interface SaveNamePlacementInput {
  eventId: string;
  certTypeId: string;
  nameXPt: number;
  nameYPt: number;
  maxNameWidthPt: number;
  nameFont: string;
  nameBold: boolean;
  nameSizePt: number;
  nameColor: string;
  nameAlign: "left" | "center" | "right";
}

/**
 * Saves the visual name box placement (in PDF points, origin bottom-left)
 * and typography settings on certificate_types.
 */
export async function saveNamePlacementAction(
  input: SaveNamePlacementInput,
): Promise<TemplateActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in." };
  }

  const placeParsed = SaveNamePlacementSchema.safeParse(input);
  if (!placeParsed.success) {
    return {
      error: formatZodError(placeParsed.error),
      code: "VALIDATION_ERROR",
    };
  }

  try {
    await assertWithinPlan(org.id, placeParsed.data.eventId, "write");
  } catch (err) {
    if (isPlanEnforcementError(err)) {
      return { code: err.code, error: err.message };
    }
    throw err;
  }

  const nameXPt = Number(Number(placeParsed.data.nameXPt).toFixed(2));
  const nameYPt = Number(Number(placeParsed.data.nameYPt).toFixed(2));
  const maxNameWidthPt = Number(Number(placeParsed.data.maxNameWidthPt).toFixed(2));
  const nameSizePt = Number(Number(placeParsed.data.nameSizePt).toFixed(2));

  const fontDef = resolveCuratedFont(placeParsed.data.nameFont);

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();

  const { data: certType } = await supabase
    .from("certificate_types")
    .select("id, page_width_pt, page_height_pt")
    .eq("id", input.certTypeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (!certType) {
    return { error: "Certificate type not found.", code: "NOT_FOUND" };
  }

  const { error: updateErr } = await supabase
    .from("certificate_types")
    .update({
      name_x: nameXPt,
      name_y: nameYPt,
      max_name_width: maxNameWidthPt,
      name_font: fontDef.id,
      name_bold: Boolean(input.nameBold),
      name_size: nameSizePt,
      name_color: input.nameColor.toUpperCase(),
      name_align: input.nameAlign,
    })
    .eq("id", input.certTypeId)
    .eq("event_id", input.eventId)
    .eq("org_id", org.id);

  if (updateErr) {
    return {
      error: sanitizeClientErrorMessage(updateErr, "Failed to save name placement."),
    };
  }

  try {
    await admin.from("audit_log").insert({
      org_id: org.id,
      user_id: user.id,
      action: "certificate_type.placement_saved",
      details: {
        event_id: input.eventId,
        certificate_type_id: input.certTypeId,
        name_x_pt: nameXPt,
        name_y_pt: nameYPt,
        max_name_width_pt: maxNameWidthPt,
        name_font: fontDef.id,
        name_bold: Boolean(input.nameBold),
        name_size_pt: nameSizePt,
        name_color: input.nameColor.toUpperCase(),
        name_align: input.nameAlign,
      },
    });
  } catch (err) {
    console.error("Failed to write audit_log for placement_saved:", err);
  }

  revalidatePath(`/dashboard/events/${input.eventId}`);
  return { success: true, certTypeId: input.certTypeId };
}
