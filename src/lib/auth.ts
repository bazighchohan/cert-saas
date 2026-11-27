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
export type OrgStatus = "pending" | "active" | "rejected" | "suspended";

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
  contactName: string | null;
  contactEmail: string | null;
  whatsappNumber: string | null;
  rejectionReason: string | null;
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

export interface PendingPurchaseSummary {
  id: string;
  planId: string | null;
  planName: string;
  kind: string;
  eventsTotal: number;
  certsPerEvent: number;
  months: number;
  listPricePkr: number;
  discountPkr: number;
  finalPricePkr: number;
  status: string;
  createdAt: string;
}

export interface PendingPageData {
  user: CurrentUser;
  org: CurrentOrg | null;
  orgCreatedAt: string | null;
  purchaseSummary: PendingPurchaseSummary | null;
  isSuperAdmin: boolean;
}

interface ProvisionRpcRow {
  org_id: string;
  org_name: string;
  org_slug: string;
  plan_id: string | null;
  role: OrgRole;
  org_status?: OrgStatus;
}

const checkSuperAdminUserId = cache(async (userId: string): Promise<boolean> => {
  if (!userId) return false;
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("super_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    return data.user_id === userId;
  } catch {
    return false;
  }
});

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
 * Resolves a non-null, non-empty organization name (2..200 chars).
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

function normalizeOrgStatus(raw: unknown): OrgStatus {
  if (raw === "pending" || raw === "active" || raw === "rejected" || raw === "suspended") {
    return raw;
  }
  return "pending";
}

/**
 * Queries the user's existing organization membership + package purchases using
 * the service-role client.
 */
export async function findExistingOrgForUser(
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
  const status = normalizeOrgStatus(org.status);

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
  if (status === "pending") {
    packageLabel = "Pending Approval";
  } else if (status === "rejected") {
    packageLabel = "Rejected";
  } else if (hasActivePurchase) {
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
    contactName:
      typeof org.contact_name === "string" ? org.contact_name : null,
    contactEmail:
      typeof org.contact_email === "string" ? org.contact_email : userEmail || null,
    whatsappNumber:
      typeof org.whatsapp_number === "string" ? org.whatsapp_number : null,
    rejectionReason:
      typeof org.rejection_reason === "string" ? org.rejection_reason : null,
    planExpiresAt: relevantExpiry,
    planExpiringSoon: expiringSoon,
    hasActivePurchase,
    hasPendingPurchase,
    hasExpiredPurchaseOnly,
    isReadOnly: status !== "active" || hasExpiredPurchaseOnly,
    role: (data.role as OrgRole) ?? "owner",
    userId,
    userEmail,
  };
}

const inflightProvisions = new Map<string, Promise<CurrentOrg>>();

/**
 * Atomically provisions an organization with `status = 'pending'` (never `'active'`).
 * Every new organization requires approval before accessing `/dashboard`.
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

    const { data: rpcData, error: rpcError } = await admin.rpc(
      "create_organization_for_user",
      {
        p_user_id: userId,
        p_org_name: resolvedName,
        p_initial_status: "pending",
      },
    );

    if (!rpcError && rpcData) {
      const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
        | ProvisionRpcRow
        | undefined;
      if (row && row.org_id) {
        const orgStatus = normalizeOrgStatus(row.org_status ?? "pending");
        return {
          id: row.org_id,
          name: row.org_name || resolvedName,
          slug: row.org_slug,
          planId: row.plan_id ?? null,
          packageLabel: "Pending Approval",
          status: orgStatus,
          contactName: null,
          contactEmail: userEmail || null,
          whatsappNumber: null,
          rejectionReason: null,
          planExpiresAt: null,
          planExpiringSoon: false,
          hasActivePurchase: false,
          hasPendingPurchase: false,
          hasExpiredPurchaseOnly: false,
          isReadOnly: true,
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

    // Fallback path: always create with status = 'pending'
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
          status: "pending",
          contact_email: userEmail || null,
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
          status: "pending",
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
      packageLabel: "Pending Approval",
      status: "pending",
      contactName: null,
      contactEmail: userEmail || null,
      whatsappNumber: null,
      rejectionReason: null,
      planExpiresAt: null,
      planExpiringSoon: false,
      hasActivePurchase: false,
      hasPendingPurchase: false,
      hasExpiredPurchaseOnly: false,
      isReadOnly: true,
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

/**
 * Server-side access gate used by EVERY dashboard Server Action and API route:
 * Returns `CurrentOrg` ONLY when `org.status === 'active'` OR the user is a
 * platform super admin (`public.super_admins`).
 * Non-active organizations (`pending`, `rejected`, `suspended`) receive `null`,
 * blocking every dashboard API mutation/read and server action.
 */
export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const { org } = await getCurrentOrgResult();
  if (!org) {
    return null;
  }
  if (org.status !== "active") {
    const isSuperAdmin = await checkSuperAdminUserId(org.userId);
    if (!isSuperAdmin) {
      return null;
    }
  }
  return org;
});

/**
 * Server Component / Server Action access gate:
 * Redirects unauthenticated users to `/login` and any logged-in user whose
 * organization is not `'active'` to `/pending` (exempting `super_admins`).
 */
export async function requireDashboardAuth(): Promise<{
  user: CurrentUser;
  org: CurrentOrg;
}> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const [{ org, error }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    checkSuperAdminUserId(user.id),
  ]);
  if (!org) {
    throw new Error(
      error || "Your organization could not be set up automatically.",
    );
  }
  if (org.status !== "active" && !isSuperAdmin) {
    redirect("/pending");
  }
  return { user, org };
}

/**
 * Loads the signed-in user's organization & initial purchase summary for `/pending`.
 */
export async function getPendingPageData(): Promise<PendingPageData | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const [{ org }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    checkSuperAdminUserId(user.id),
  ]);

  if (!org) {
    return {
      user,
      org: null,
      orgCreatedAt: null,
      purchaseSummary: null,
      isSuperAdmin,
    };
  }

  const admin = getSupabaseAdmin();
  const [orgMetaRes, purchaseRes] = await Promise.all([
    admin
      .from("organizations")
      .select("created_at")
      .eq("id", org.id)
      .maybeSingle(),
    admin
      .from("purchases")
      .select(
        "id, plan_id, kind, events_total, certs_per_event, months, list_price_pkr, discount_pkr, final_price_pkr, status, created_at, plans(name)",
      )
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let purchaseSummary: PendingPurchaseSummary | null = null;
  if (purchaseRes.data) {
    const p = purchaseRes.data as Record<string, unknown>;
    const planRel = Array.isArray(p.plans)
      ? (p.plans[0] as Record<string, unknown> | undefined)
      : (p.plans as Record<string, unknown> | undefined);
    const kind = String(p.kind ?? "custom");
    const eventsTotal = Number(p.events_total ?? 1);
    const certsPerEvent = Number(p.certs_per_event ?? 50);
    purchaseSummary = {
      id: String(p.id),
      planId: typeof p.plan_id === "string" ? p.plan_id : null,
      planName:
        typeof planRel?.name === "string"
          ? planRel.name
          : kind === "custom"
            ? `Custom (${eventsTotal} × ${certsPerEvent} certs)`
            : `${kind.toUpperCase()} (${eventsTotal} × ${certsPerEvent} certs)`,
      kind,
      eventsTotal,
      certsPerEvent,
      months: Number(p.months ?? 3),
      listPricePkr: Number(p.list_price_pkr ?? 0),
      discountPkr: Number(p.discount_pkr ?? 0),
      finalPricePkr: Number(p.final_price_pkr ?? 0),
      status: String(p.status ?? "pending"),
      createdAt: String(p.created_at ?? ""),
    };
  }

  return {
    user,
    org,
    orgCreatedAt:
      typeof orgMetaRes.data?.created_at === "string"
        ? orgMetaRes.data.created_at
        : null,
    purchaseSummary,
    isSuperAdmin,
  };
}
