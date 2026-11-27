"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { executeOrganizationDeletion } from "@/lib/data-deletion";
import {
  ChangePasswordSchema,
  DeleteOrganizationSchema,
  UpdateOrgNameSchema,
} from "@/lib/schemas";
import { formatZodError, sanitizeClientErrorMessage } from "@/lib/security";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SettingsActionResult {
  success?: boolean;
  error?: string;
  orgName?: string;
  redirectTo?: string;
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

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
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

  try {
    await admin.from("audit_log").insert({
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

/**
 * Permanently deletes the current user's organization (`getCurrentOrg()`),
 * including all events, attendees, issued certificates, private storage
 * templates, payment receipt screenshots, download logs, and audit logs.
 * Requires `owner` role and typed confirmation matching `org.slug`.
 */
export async function deleteOrganizationAction(input: {
  confirmSlug: string;
}): Promise<SettingsActionResult> {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return { error: "You must be signed in to delete your organization." };
  }

  if (org.role !== "owner") {
    return {
      error: "Only the organization owner can permanently delete this organization.",
    };
  }

  const parsed = DeleteOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return { error: formatZodError(parsed.error) };
  }

  if (parsed.data.confirmSlug.trim().toLowerCase() !== org.slug.toLowerCase()) {
    return {
      error: `Please type "${org.slug}" to confirm permanent deletion.`,
    };
  }

  const admin = getSupabaseAdmin();

  try {
    await executeOrganizationDeletion({
      orgId: org.id,
      adapter: {
        async getEventScopedPaths() {
          return { templatePaths: [], proofPaths: [] };
        },
        async purgeEventRows() {
          return { attendeesDeleted: 0 };
        },
        async getOrgScopedPaths(orgId) {
          const [ctRes, purRes, topRes, payReqRes] = await Promise.all([
            admin
              .from("certificate_types")
              .select("template_path")
              .eq("org_id", orgId),
            admin
              .from("purchases")
              .select("screenshot_path")
              .eq("org_id", orgId),
            admin
              .from("certificate_topups")
              .select("screenshot_path")
              .eq("org_id", orgId),
            admin
              .from("payment_requests")
              .select("screenshot_path")
              .eq("org_id", orgId),
          ]);

          return {
            templatePaths: (ctRes.data ?? []).map(
              (r) => (r.template_path as string | null) ?? "",
            ),
            proofPaths: [
              ...(purRes.data ?? []).map(
                (r) => (r.screenshot_path as string | null) ?? "",
              ),
              ...(topRes.data ?? []).map(
                (r) => (r.screenshot_path as string | null) ?? "",
              ),
              ...(payReqRes.data ?? []).map(
                (r) => (r.screenshot_path as string | null) ?? "",
              ),
            ],
          };
        },
        async removeStorageObjects(bucket, paths) {
          try {
            await admin.storage.from(bucket).remove(paths);
          } catch {
            // Non-fatal if bucket/object already absent
          }
        },
        async purgeOrganizationRows(orgId) {
          // Delete child tables in explicit FK-safe order (events BEFORE purchases
          // so events_purchase_fk ON DELETE RESTRICT never blocks deletion)
          await admin.from("download_log").delete().eq("org_id", orgId);
          await admin
            .from("attendee_certificates")
            .delete()
            .eq("org_id", orgId);
          await admin.from("attendees").delete().eq("org_id", orgId);
          await admin.from("certificate_topups").delete().eq("org_id", orgId);
          await admin.from("certificate_types").delete().eq("org_id", orgId);
          await admin.from("events").delete().eq("org_id", orgId);
          await admin.from("payments").delete().eq("org_id", orgId);
          await admin.from("payment_requests").delete().eq("org_id", orgId);
          await admin.from("purchases").delete().eq("org_id", orgId);
          await admin.from("audit_log").delete().eq("org_id", orgId);
          await admin.from("organization_members").delete().eq("org_id", orgId);

          const { error: orgDelErr } = await admin
            .from("organizations")
            .delete()
            .eq("id", orgId);

          if (orgDelErr) {
            throw new Error(orgDelErr.message);
          }
        },
      },
    });
  } catch (err) {
    return {
      error: sanitizeClientErrorMessage(
        err,
        "Failed to delete your organization. Please try again.",
      ),
    };
  }

  // Sign out session & delete auth user if they own no other orgs and aren't a super_admin
  const [otherMembershipsRes, isSuper] = await Promise.all([
    admin
      .from("organization_members")
      .select("org_id", { count: "exact", head: true })
      .eq("user_id", user.id),
    isUserInSuperAdminsTable(user.id),
  ]);

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut().catch(() => {});

  if ((otherMembershipsRes.count ?? 0) === 0 && !isSuper) {
    await admin.auth.admin.deleteUser(user.id).catch(() => {});
  }

  revalidatePath("/");
  return { success: true, redirectTo: "/" };
}
