import "server-only";

import { cache } from "react";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import {
  isPlanExpired,
  isPlanExpiringWithinDays,
} from "@/lib/plan-enforcement-helpers";
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
  planId: string | null;
  packageLabel: string;
  status: OrgStatus;
  planExpiresAt: string | null;
  planExpiringSoon: boolean;
  hasActivePurchase: boolean;
  hasPendingPurchase: boolean;
  hasExpiredPurchaseOnly: boolean;
  isReadOnly: boolean;
  role: OrgRole;
  userId: string;
  userEmail: string;
}

interface ProvisionRpcRow {
  org_id: string;
  org_name: string;
  org_slug: string;
  plan_id: string | null;
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
 * Queries the user's existing organization membership + package purchases using
 * the service-role client.
 */
async function findExistingOrgForUser(
  userId: string,
  userEmail: string,
): Promise<CurrentOrg | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("organization_members")
    .select("role, organizations!inner(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.organizations) {
    return null;
  }

  const org = (Array.isArray(data.organizations)
    ? data.organizations[0]
    : data.organizations) as Record<string, unknown> | undefined;

  if (!org) return null;

  const orgId = org.id as string;
  const status = ((org.status as OrgStatus) ?? "active") as OrgStatus;

  const { data: purchaseRows } = await admin
    .from("purchases")
    .select("id, kind, is_pilot, status, expires_at")
    .eq("org_id", orgId)
    .order("expires_at", { ascending: true });

  const nowMs = Date.now();
  const list = (purchaseRows ?? []) as Array<Record<string, unknown>>;

  const activeUnexpired = list.filter(
    (p) =>
      p.status === "active" &&
      !isPlanExpired(
        typeof p.expires_at === "string" ? p.expires_at : null,
        nowMs,
      ),
  );
  const pendingList = list.filter((p) => p.status === "pending");
  const expiredList = list.filter(
    (p) =>
      p.status === "expired" ||
      (p.status === "active" &&
        isPlanExpired(
          typeof p.expires_at === "string" ? p.expires_at : null,
          nowMs,
        )),
  );

  const hasActivePurchase = activeUnexpired.length > 0;
  const hasPendingPurchase = pendingList.length > 0;
  const hasExpiredPurchaseOnly =
    !hasActivePurchase && !hasPendingPurchase && expiredList.length > 0;

  // Earliest active expiry (for warning) or latest expired date
  let relevantExpiry: string | null = null;
  if (activeUnexpired.length > 0) {
    const firstExp = activeUnexpired.find(
      (p) => typeof p.expires_at === "string",
    );
    relevantExpiry = firstExp ? (firstExp.expires_at as string) : null;
  } else if (expiredList.length > 0) {
    const lastExp = expiredList[expiredList.length - 1];
    relevantExpiry =
      typeof lastExp?.expires_at === "string" ? lastExp.expires_at : null;
  }

  const expiringSoon =
    hasActivePurchase && isPlanExpiringWithinDays(relevantExpiry, 14, nowMs);

  let packageLabel = "No Package";
  if (hasActivePurchase) {
    if (activeUnexpired.length > 1) {
      packageLabel = `${activeUnexpired.length} Packages`;
    } else {
      const p0 = activeUnexpired[0];
      packageLabel = p0.is_pilot
        ? "Pilot"
        : String(p0.kind ?? "Active").toUpperCase();
    }
  } else if (hasPendingPurchase) {
    packageLabel = "Pending Approval";
  } else if (hasExpiredPurchaseOnly) {
    packageLabel = "Expired";
  }

  return {
    id: orgId,
    name: org.name as string,
    slug: org.slug as string,
    planId: typeof org.plan_id === "string" ? org.plan_id : null,
    packageLabel,
    status,
    planExpiresAt: relevantExpiry,
    planExpiringSoon: expiringSoon,
    hasActivePurchase,
    hasPendingPurchase,
    hasExpiredPurchaseOnly,
    // Read-only banner shows when previously active purchase(s) have all expired
    isReadOnly: status !== "active" || hasExpiredPurchaseOnly,
    role: (data.role as OrgRole) ?? "owner",
    userId,
    userEmail,
  };
}

// Per-process lock map to serialize double-click / concurrent requests for the same userId
const inflightProvisions = new Map<string, Promise<CurrentOrg>>();

/**
 * Atomically provisions the user's organization (with NO Free plan — every org
 * needs an approved purchase before creating or releasing events), owner membership,
 * and audit_log entry.
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

    // Primary path: single Postgres transaction via RPC create_organization_for_user.
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
          planId: row.plan_id ?? null,
          packageLabel: "No Package",
          status: "active",
          planExpiresAt: null,
          planExpiringSoon: false,
          hasActivePurchase: false,
          hasPendingPurchase: false,
          hasExpiredPurchaseOnly: false,
          isReadOnly: false,
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
      });
    }

    const afterRpcExisting = await findExistingOrgForUser(userId, userEmail);
    if (afterRpcExisting) {
      return afterRpcExisting;
    }

    // Fallback path: create organization with plan_id = null (no Free plan)
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
          plan_id: null,
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
          plan_id: null,
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
      planId: null,
      packageLabel: "No Package",
      status: "active",
      planExpiresAt: null,
      planExpiringSoon: false,
      hasActivePurchase: false,
      hasPendingPurchase: false,
      hasExpiredPurchaseOnly: false,
      isReadOnly: false,
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

export const getCurrentOrgResult = cache(
  async (): Promise<{ org: CurrentOrg | null; error: string | null }> => {
    const user = await getCurrentUser();
    if (!user) {
      return { org: null, error: "Not signed in." };
    }

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

export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const { org } = await getCurrentOrgResult();
  if (!org || org.status !== "active") {
    return null;
  }
  return org;
});

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
  if (org.status !== "active") {
    redirect("/account-suspended");
  }
  return { user, org };
}
