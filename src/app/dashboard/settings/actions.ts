"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
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

  const cleanName = input.name.trim();
  if (cleanName.length < 2 || cleanName.length > 200) {
    return {
      error: "Organization name must be between 2 and 200 characters.",
    };
  }

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
      error: error?.message || "Could not update organization name.",
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

  const { newPassword } = input;
  if (!newPassword || newPassword.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });

  if (error) {
    return { error: error.message };
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
