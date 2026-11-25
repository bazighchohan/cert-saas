import "server-only";

import { cache } from "react";
import { randomUUID } from "node:crypto";
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
  userMetadata: Record<string, unknown>;
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
 * Cleans and title-cases the local part of an email address (before '@').
 * Returns null if no usable name can be derived.
 */
export function deriveOrgNameFromEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleaned) return null;

  const titleCased = cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  if (titleCased.length >= 2) {
    return titleCased.slice(0, 200);
  }
  if (titleCased.length === 1) {
    return `${titleCased} Organization`;
  }
  return null;
}

/**
 * Resolves a non-null, non-empty organization name (2..200 chars) in this exact order:
 * 1. Explicit organization name argument (if non-empty)
 * 2. user_metadata.organization_name (or user_metadata.org_name)
 * 3. Name derived from email (part before '@', cleaned and title-cased)
 * 4. "My Organization"
 */
export function resolveOrganizationName(input: {
  explicitName?: string | null;
  userMetadata?: Record<string, unknown> | null;
  email?: string | null;
}): string {
  const candidates: Array<string | null | undefined> = [
    input.explicitName,
    typeof input.userMetadata?.organization_name === "string"
      ? input.userMetadata.organization_name
      : null,
    typeof input.userMetadata?.org_name === "string"
      ? input.userMetadata.org_name
      : null,
    deriveOrgNameFromEmail(input.email),
    "My Organization",
  ];

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (trimmed.length >= 2) {
      return trimmed.slice(0, 200);
    }
    if (trimmed.length === 1) {
      return `${trimmed.toUpperCase()} Organization`;
    }
  }

  return "My Organization";
}

/**
 * Generates a URL-safe base slug (2..50 chars) from an organization name.
 */
export function slugifyOrganizationName(name: string, userIdFallback = ""): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");

  if (base.length >= 2) return base;
  const suffix = userIdFallback.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8) || "default";
  return `org-${suffix}`;
}

/**
 * Queries the user's existing organization membership using the service-role client
 * (reliable even before session cookies finish propagating during signup/callback).
 */
async function findExistingOrgForUser(
  userId: string,
  userEmail: string,
): Promise<CurrentOrg | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("organization_members")
    .select("role, organizations!inner(id, name, slug, plan_id, status)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.organizations) {
    return null;
  }

  const org = Array.isArray(data.organizations)
    ? data.organizations[0]
    : data.organizations;

  if (!org) return null;

  return {
    id: org.id as string,
    name: org.name as string,
    slug: org.slug as string,
    planId: org.plan_id as string,
    status: (org.status as OrgStatus) ?? "active",
    role: (data.role as OrgRole) ?? "owner",
    userId,
    userEmail,
  };
}

// Per-process lock map to serialize double-click / concurrent requests for the same userId
const inflightProvisions = new Map<string, Promise<CurrentOrg>>();

/**
 * Atomically provisions the user's organization (on the Free plan), owner membership,
 * and audit_log entry.
 * - Resolves organization name in order: explicitName -> user_metadata.organization_name -> email prefix -> "My Organization".
 * - Idempotent: if the user already has a membership, returns the existing organization.
 * - Uses the transactional RPC `create_organization_for_user`, with an atomic fallback
 *   cleanup if an older unpatched SQL function exists in the database.
 */
export async function provisionOrganizationForUser(
  userId: string,
  orgName?: string | null,
  userEmail = "",
  userMetadata?: Record<string, unknown> | null,
): Promise<CurrentOrg> {
  const existingInflight = inflightProvisions.get(userId);
  if (existingInflight) {
    return existingInflight;
  }

  const task = (async (): Promise<CurrentOrg> => {
    // 1. Fast idempotency check: if the user already has a membership, do nothing.
    const alreadyMember = await findExistingOrgForUser(userId, userEmail);
    if (alreadyMember) {
      return alreadyMember;
    }

    const resolvedName = resolveOrganizationName({
      explicitName: orgName,
      userMetadata,
      email: userEmail,
    });

    const admin = getSupabaseAdmin();

    // 2. Primary path: single Postgres transaction via RPC create_organization_for_user.
    const { data: rpcData, error: rpcError } = await admin.rpc(
      "create_organization_for_user",
      {
        p_user_id: userId,
        p_org_name: resolvedName,
      },
    );

    if (!rpcError && rpcData) {
      const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
        | ProvisionRpcRow
        | undefined;
      if (row && row.org_id) {
        return {
          id: row.org_id,
          name: row.org_name || resolvedName,
          slug: row.org_slug,
          planId: row.plan_id || "free",
          status: "active",
          role: row.role || "owner",
          userId,
          userEmail,
        };
      }
    }

    if (rpcError) {
      console.error("[auth:provisionOrganizationForUser] RPC error:", {
        userId,
        resolvedName,
        code: rpcError.code,
        message: rpcError.message,
        details: rpcError.details,
        hint: rpcError.hint,
      });
    }

    // Re-check membership in case a concurrent request won the race.
    const afterRpcExisting = await findExistingOrgForUser(userId, userEmail);
    if (afterRpcExisting) {
      return afterRpcExisting;
    }

    // 3. Fallback path (if the user's Supabase DB still has the unpatched 003 SQL function):
    //    Create organization + owner membership + Free plan with rollback on partial failure.
    const baseSlug = slugifyOrganizationName(resolvedName, userId);
    let createdOrgId: string | null = null;
    let createdSlug = baseSlug;

    for (let attempt = 0; attempt < 8; attempt++) {
      const candidateSlug =
        attempt === 0
          ? baseSlug
          : `${baseSlug}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;

      const { data: insertedOrg, error: orgInsertErr } = await admin
        .from("organizations")
        .insert({
          name: resolvedName,
          slug: candidateSlug,
          plan_id: "free",
          status: "active",
        })
        .select("id, name, slug, plan_id")
        .maybeSingle();

      if (!orgInsertErr && insertedOrg) {
        createdOrgId = insertedOrg.id as string;
        createdSlug = insertedOrg.slug as string;
        break;
      }

      if (orgInsertErr?.code === "23505") {
        continue;
      }

      console.error(
        "[auth:provisionOrganizationForUser] Fallback organization insert failed:",
        orgInsertErr,
      );
      throw new Error(
        orgInsertErr?.message || "Failed to create organization record.",
      );
    }

    if (!createdOrgId) {
      throw new Error("Could not allocate a unique organization slug.");
    }

    // Re-check if another concurrent request created a membership while we were inserting.
    const raceWinner = await findExistingOrgForUser(userId, userEmail);
    if (raceWinner) {
      await admin.from("organizations").delete().eq("id", createdOrgId);
      return raceWinner;
    }

    const { error: memberErr } = await admin
      .from("organization_members")
      .insert({
        org_id: createdOrgId,
        user_id: userId,
        role: "owner",
      });

    if (memberErr) {
      console.error(
        "[auth:provisionOrganizationForUser] Membership insert failed, rolling back org:",
        memberErr,
      );
      // Roll back the created organization so no half-created orphan org remains.
      await admin.from("organizations").delete().eq("id", createdOrgId);
      const concurrentOrg = await findExistingOrgForUser(userId, userEmail);
      if (concurrentOrg) return concurrentOrg;
      throw new Error(`Failed to create organization membership: ${memberErr.message}`);
    }

    try {
      await admin.from("audit_log").insert({
        org_id: createdOrgId,
        user_id: userId,
        action: "org.created",
        details: {
          name: resolvedName,
          slug: createdSlug,
          plan_id: "free",
        },
      });
    } catch (auditErr) {
      console.error(
        "[auth:provisionOrganizationForUser] Non-fatal audit_log error:",
        auditErr,
      );
    }

    return {
      id: createdOrgId,
      name: resolvedName,
      slug: createdSlug,
      planId: "free",
      status: "active",
      role: "owner",
      userId,
      userEmail,
    };
  })();

  inflightProvisions.set(userId, task);
  try {
    return await task;
  } finally {
    inflightProvisions.delete(userId);
  }
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

    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
    const rawMetaOrg =
      typeof metadata.organization_name === "string" &&
      metadata.organization_name.trim()
        ? metadata.organization_name.trim()
        : typeof metadata.org_name === "string" && metadata.org_name.trim()
          ? metadata.org_name.trim()
          : null;

    return {
      id: user.id,
      email: user.email,
      emailConfirmedAt: user.email_confirmed_at ?? null,
      orgNameFromMeta: rawMetaOrg && rawMetaOrg.length >= 2 ? rawMetaOrg : null,
      userMetadata: metadata,
    };
  } catch (err) {
    console.error("[auth:getCurrentUser] Failed to read current user:", err);
    return null;
  }
});

/**
 * Resolves the current logged-in user's organization, auto-provisioning one
 * if the user has no organization membership yet.
 * Returns { org, error } so callers can render a clear error page with a retry
 * button instead of redirecting in a loop.
 */
export const getCurrentOrgResult = cache(
  async (): Promise<{ org: CurrentOrg | null; error: string | null }> => {
    const user = await getCurrentUser();
    if (!user) {
      return { org: null, error: "Not signed in." };
    }

    // 1. Check via user's RLS session client first, then service-role check
    try {
      const existing = await findExistingOrgForUser(user.id, user.email);
      if (existing) {
        return { org: existing, error: null };
      }
    } catch (lookupErr) {
      console.error(
        "[auth:getCurrentOrgResult] Membership lookup error:",
        lookupErr,
      );
    }

    // 2. User has no organization membership yet -> auto-provision using the 4-step name resolution order.
    const resolvedName = resolveOrganizationName({
      explicitName: user.orgNameFromMeta,
      userMetadata: user.userMetadata,
      email: user.email,
    });

    try {
      const provisioned = await provisionOrganizationForUser(
        user.id,
        resolvedName,
        user.email,
        user.userMetadata,
      );
      return { org: provisioned, error: null };
    } catch (err) {
      console.error(
        "[auth:getCurrentOrgResult] Auto-provisioning failed for user:",
        {
          userId: user.id,
          email: user.email,
          resolvedName,
          error: err,
        },
      );
      const message =
        err instanceof Error
          ? err.message
          : "Could not provision your organization.";
      return { org: null, error: message };
    }
  },
);

/**
 * Returns the current logged-in user's organization, or null if unauthenticated
 * or provisioning failed.
 */
export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const { org } = await getCurrentOrgResult();
  return org;
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
  const { org, error } = await getCurrentOrgResult();
  if (!org) {
    throw new Error(
      error || "Your organization could not be set up automatically.",
    );
  }
  return { user, org };
}
