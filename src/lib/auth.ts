import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type OrgRole = "owner" | "admin";
export type OrgStatus = "active" | "suspended";

export interface CurrentUser {
  id: string;
  email: string;
  emailConfirmedAt: string | null;
  orgNameFromMeta: string | null;
}

export interface CurrentOrg {
  id: string;
  name: string;
  slug: string;
  planId: string;
  status: OrgStatus;
  role: OrgRole;
  userId: string;
  userEmail: string;
}

interface ProvisionRpcRow {
  org_id: string;
  org_name: string;
  org_slug: string;
  plan_id: string;
  role: OrgRole;
}

/**
 * Atomically creates the organization (on the Free plan), owner membership,
 * and audit_log entry in one database transaction via service_role RPC.
 * Idempotent: if the user already has an organization, returns that organization.
 */
export async function provisionOrganizationForUser(
  userId: string,
  orgName: string,
  userEmail = "",
): Promise<CurrentOrg> {
  const trimmed = orgName.trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    throw new Error("Organization name must be between 2 and 200 characters.");
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc("create_organization_for_user", {
    p_user_id: userId,
    p_org_name: trimmed,
  });

  if (error) {
    throw new Error(`Failed to provision organization: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as ProvisionRpcRow | undefined;
  if (!row || !row.org_id) {
    throw new Error("Organization provisioning returned no row.");
  }

  return {
    id: row.org_id,
    name: row.org_name,
    slug: row.org_slug,
    planId: row.plan_id,
    status: "active",
    role: row.role,
    userId,
    userEmail,
  };
}

/**
 * Returns the authenticated Supabase user verified against the Auth server,
 * or null if not logged in. Cached per server request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user || !user.email) {
      return null;
    }

    const metaOrg =
      typeof user.user_metadata?.org_name === "string"
        ? user.user_metadata.org_name.trim()
        : null;

    return {
      id: user.id,
      email: user.email,
      emailConfirmedAt: user.email_confirmed_at ?? null,
      orgNameFromMeta: metaOrg && metaOrg.length >= 2 ? metaOrg : null,
    };
  } catch {
    return null;
  }
});

/**
 * Returns the current logged-in user's organization membership and org details.
 * Never trusts any org_id from the client: resolves solely from the verified
 * server session cookie -> organization_members.
 *
 * If the user confirmed their email via link and does not yet have an
 * organization row, automatically provisions their org from user_metadata.org_name.
 */
export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select(
      "role, organizations!inner(id, name, slug, plan_id, status)",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!error && data && data.organizations) {
    const org = Array.isArray(data.organizations)
      ? data.organizations[0]
      : data.organizations;

    if (org) {
      return {
        id: org.id as string,
        name: org.name as string,
        slug: org.slug as string,
        planId: org.plan_id as string,
        status: (org.status as OrgStatus) ?? "active",
        role: (data.role as OrgRole) ?? "admin",
        userId: user.id,
        userEmail: user.email,
      };
    }
  }

  // Fallback for users returning from an email confirmation link whose org
  // wasn't provisioned yet (or if a fallback org name can be derived).
  const fallbackName =
    user.orgNameFromMeta ||
    `${user.email.split("@")[0].replace(/[^a-zA-Z0-9 _-]/g, " ").trim() || "My"}'s Organization`;

  try {
    return await provisionOrganizationForUser(user.id, fallbackName, user.email);
  } catch (err) {
    console.error("Failed to auto-provision organization for user:", err);
    return null;
  }
});

/**
 * Helper for /dashboard/** Server Components and Server Actions.
 * Redirects unauthenticated users to /login.
 */
export async function requireDashboardAuth(): Promise<{
  user: CurrentUser;
  org: CurrentOrg;
}> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const org = await getCurrentOrg();
  if (!org) {
    redirect("/login?error=org_missing");
  }
  return { user, org };
}
