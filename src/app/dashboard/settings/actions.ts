"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { ChangePasswordSchema, UpdateOrgNameSchema } from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SettingsActionResult {
  success?: boolean;
  error?: string;
  orgName?: string;
}

/**
 * Updates the current user's organization name.
 * Never accepts an org_id from the client — always scopes by getCurrentOrg().
 */
export async function updateOrganizationNameAction(input: {
  name: string;
}): Promise<SettingsActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to update settings." };
  }

  const parsed = UpdateOrgNameSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }
  const cleanName = parsed.data.name;

  if (cleanName === org.name) {
    return { success: true, orgName: cleanName };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("organizations")
    .update({ name: cleanName })
    .eq("id", org.id)
    .select("id, name")
    .maybeSingle();

  if (error || !data) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Could not update organization name.",
      ),
    };
  }

  // Record audit log entry scoped to org.id.
  try {
    await getSupabaseAdmin()
      .from("audit_log")
      .insert({
        org_id: org.id,
        user_id: user.id,
        action: "org.renamed",
        details: { previous_name: org.name, new_name: cleanName },
      });
  } catch (err) {
    console.error("Failed to write audit_log for org.renamed:", err);
  }

  revalidatePath("/dashboard", "layout");
  return { success: true, orgName: data.name as string };
}

/**
 * Changes the signed-in user's password via Supabase Auth.
 */
export async function changePasswordAction(input: {
  newPassword: string;
}): Promise<SettingsActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to change your password." };
  }

  const parsed = ChangePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });

  if (error) {
    return {
      error: sanitizeClientErrorMessage(
        error,
        "Could not update password. Please choose a different password.",
      ),
    };
  }

  try {
    await getSupabaseAdmin()
      .from("audit_log")
      .insert({
        org_id: org.id,
        user_id: user.id,
        action: "user.password_changed",
        details: {},
      });
  } catch (err) {
    console.error("Failed to write audit_log for user.password_changed:", err);
  }

  return { success: true };
}
