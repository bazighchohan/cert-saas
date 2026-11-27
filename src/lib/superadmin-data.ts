import "server-only";

import {
  mapPurchaseRow,
  mapTopupRow,
  type CertificateTopupRow,
  type PurchaseRow,
} from "@/lib/dashboard-data";
import { getFeatureFlags, type PlatformFeatureFlags } from "@/lib/feature-flags";
import {
  DEFAULT_PAYMENT_SETTINGS,
  getPaymentSettings,
  type PaymentSettingsData,
} from "@/lib/payment-settings";
import { isPlanExpired } from "@/lib/plan-enforcement-helpers";
import type { PricedPlanPreset, PricingConfig } from "@/lib/pricing";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  buildMonthlyRevenueSeries,
  type ApprovedPaymentForRevenue,
  type MonthlyRevenuePoint,
  type SuperAdminOrgRow,
  type SuperAdminOrgStatus,
} from "@/lib/superadmin-helpers";

export interface PlatformAuditLogItem {
  id: string;
  orgId: string;
  orgName: string;
  userId: string | null;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ExpiringPurchaseOverviewItem {
  purchaseId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  kind: string;
  eventsUsed: number;
  eventsTotal: number;
  certsPerEvent: number;
  isPilot: boolean;
  expiresAt: string;
  daysRemaining: number;
}

export { DEFAULT_PAYMENT_SETTINGS, getPaymentSettings };
export type { PaymentSettingsData };

export interface SignupRequestQueueRow {
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgStatus: SuperAdminOrgStatus;
  contactName: string;
  email: string;
  whatsappNumber: string;
  rejectionReason: string | null;
  purchaseId: string | null;
  purchaseStatus: string;
  planId: string | null;
  planSummary: string;
  eventsTotal: number;
  certsPerEvent: number;
  months: number;
  listPricePkr: number;
  discountPkr: number;
  finalPricePkr: number;
  isPilot: boolean;
  paymentNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface PlatformOverviewData {
  totalOrgs: number;
  activeOrgs: number;
  pendingOrgs: number;
  rejectedOrgs: number;
  suspendedOrgs: number;
  paidOrgs: number;
  totalEvents: number;
  releasedEvents: number;
  totalCertificatesIssued: number;
  totalDownloads: number;
  pendingPaymentsCount: number;
  totalApprovedRevenuePkr: number;
  totalApprovedRequests: number;
  monthlyRevenue: MonthlyRevenuePoint[];
  expiringWithin14Days: ExpiringPurchaseOverviewItem[];
  pricingConfig: PricingConfig;
  recentAuditLogs: PlatformAuditLogItem[];
}

export interface SuperAdminMemberRow {
  userId: string;
  email: string | null;
  role: "owner" | "admin";
  joinedAt: string;
  lastSignInAt: string | null;
}

export interface SuperAdminEventRow {
  id: string;
  title: string;
  slug: string;
  released: boolean;
  maxCertificates: number;
  retentionUntil: string | null;
  eventDate: string | null;
  attendeeCount: number;
  certificatesIssuedCount: number;
  downloadsCount: number;
  createdAt: string;
}

export interface SuperAdminOrgDetailData {
  org: {
    id: string;
    name: string;
    slug: string;
    planId: string;
    packageLabel: string;
    status: SuperAdminOrgStatus;
    contactName: string | null;
    contactEmail: string | null;
    whatsappNumber: string | null;
    rejectionReason: string | null;
    planExpiresAt: string | null;
    planExpiringSoon: boolean;
    createdAt: string;
    updatedAt: string;
  };
  presets: PricedPlanPreset[];
  usage: {
    eventsCount: number;
    eventsSlotsUsed: number;
    eventsSlotsTotal: number;
    attendeesCount: number;
    certificatesIssuedCount: number;
    downloadsCount: number;
  };
  members: SuperAdminMemberRow[];
  events: SuperAdminEventRow[];
  purchases: PurchaseRow[];
  topups: CertificateTopupRow[];
  auditLogs: PlatformAuditLogItem[];
}

export interface SuperAdminPaymentsQueueData {
  purchases: PurchaseRow[];
  topups: CertificateTopupRow[];
}

function normalizeSuperOrgStatus(raw: unknown): SuperAdminOrgStatus {
  if (
    raw === "pending" ||
    raw === "active" ||
    raw === "rejected" ||
    raw === "suspended"
  ) {
    return raw;
  }
  return "active";
}

export async function getPendingSignupRequestsCount(): Promise<number> {
  try {
    const admin = getSupabaseAdmin();
    const { count } = await admin
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function fetchMembersAuthDirectory(
  targetOrgId?: string,
): Promise<
  SuperAdminMemberRow[] & { byOrg?: Map<string, SuperAdminMemberRow[]> }
> {
  const admin = getSupabaseAdmin();
  const byOrg = new Map<string, SuperAdminMemberRow[]>();
  const flat: SuperAdminMemberRow[] = [];

  const { data: rpcData, error: rpcErr } = await admin.rpc(
    "superadmin_get_org_members_auth",
    { p_org_id: targetOrgId ?? null },
  );

  if (!rpcErr && Array.isArray(rpcData)) {
    for (const raw of rpcData as Array<Record<string, unknown>>) {
      const orgId = String(raw.org_id);
      const item: SuperAdminMemberRow = {
        userId: String(raw.user_id),
        email: typeof raw.email === "string" ? raw.email : null,
        role: raw.role === "owner" ? "owner" : "admin",
        joinedAt: String(raw.joined_at ?? ""),
        lastSignInAt:
          typeof raw.last_sign_in_at === "string" ? raw.last_sign_in_at : null,
      };
      flat.push(item);
      const list = byOrg.get(orgId) ?? [];
      list.push(item);
      byOrg.set(orgId, list);
    }
    return Object.assign(flat, { byOrg });
  }

  let q = admin
    .from("organization_members")
    .select("org_id, user_id, role, created_at")
    .order("created_at", { ascending: true });
  if (targetOrgId) {
    q = q.eq("org_id", targetOrgId);
  }

  const [{ data: memRows }, authUsersRes] = await Promise.all([
    q,
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }).catch(() => ({
      data: { users: [] },
    })),
  ]);

  const userLookup = new Map<
    string,
    { email: string | null; lastSignInAt: string | null }
  >();
  for (const u of authUsersRes.data?.users ?? []) {
    userLookup.set(u.id, {
      email: u.email ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
    });
  }

  for (const m of (memRows ?? []) as Array<Record<string, unknown>>) {
    const orgId = String(m.org_id);
    const uid = String(m.user_id);
    const meta = userLookup.get(uid);
    const item: SuperAdminMemberRow = {
      userId: uid,
      email: meta?.email ?? null,
      role: m.role === "owner" ? "owner" : "admin",
      joinedAt: String(m.created_at ?? ""),
      lastSignInAt: meta?.lastSignInAt ?? null,
    };
    flat.push(item);
    const list = byOrg.get(orgId) ?? [];
    list.push(item);
    byOrg.set(orgId, list);
  }

  return Object.assign(flat, { byOrg });
}

export async function getSuperAdminSignupRequestsData(): Promise<{
  requests: SignupRequestQueueRow[];
  pendingCount: number;
  featureFlags: PlatformFeatureFlags;
}> {
  const admin = getSupabaseAdmin();

  const [orgsRes, purchasesRes, membersDir] = await Promise.all([
    admin
      .from("organizations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(250),
    admin
      .from("purchases")
      .select("*, plans(name)")
      .order("created_at", { ascending: true }),
    fetchMembersAuthDirectory(),
  ]);

  const initialPurchaseByOrg = new Map<string, Record<string, unknown>>();
  for (const p of (purchasesRes.data ?? []) as Array<Record<string, unknown>>) {
    const oid = String(p.org_id);
    if (!initialPurchaseByOrg.has(oid)) {
      initialPurchaseByOrg.set(oid, p);
    }
  }

  const requests: SignupRequestQueueRow[] = [];
  let pendingCount = 0;

  for (const o of (orgsRes.data ?? []) as Array<Record<string, unknown>>) {
    const orgId = String(o.id);
    const orgStatus = normalizeSuperOrgStatus(o.status);
    if (orgStatus === "pending") {
      pendingCount++;
    }

    const p = initialPurchaseByOrg.get(orgId);
    const hasContactMeta =
      typeof o.contact_name === "string" ||
      typeof o.whatsapp_number === "string";

    // Include all pending/rejected orgs plus orgs that went through the signup request flow
    if (
      orgStatus !== "pending" &&
      orgStatus !== "rejected" &&
      !hasContactMeta
    ) {
      continue;
    }

    const members = membersDir.byOrg?.get(orgId) ?? [];
    const ownerEmail =
      (typeof o.contact_email === "string" && o.contact_email) ||
      members.find((m) => m.role === "owner")?.email ||
      members[0]?.email ||
      "—";

    const planRel = p
      ? Array.isArray(p.plans)
        ? (p.plans[0] as Record<string, unknown> | undefined)
        : (p.plans as Record<string, unknown> | undefined)
      : undefined;

    const kind = p ? String(p.kind ?? "custom") : "custom";
    const eventsTotal = p ? Number(p.events_total ?? 1) : 1;
    const certsPerEvent = p ? Number(p.certs_per_event ?? 50) : 50;
    const months = p ? Number(p.months ?? 3) : 3;
    const presetName =
      typeof planRel?.name === "string"
        ? planRel.name
        : kind === "custom"
          ? "Custom Package"
          : `${kind.toUpperCase()} Package`;

    requests.push({
      orgId,
      orgName: String(o.name ?? ""),
      orgSlug: String(o.slug ?? ""),
      orgStatus,
      contactName:
        typeof o.contact_name === "string" && o.contact_name.trim()
          ? o.contact_name
          : "—",
      email: ownerEmail,
      whatsappNumber:
        typeof o.whatsapp_number === "string" && o.whatsapp_number.trim()
          ? o.whatsapp_number
          : "—",
      rejectionReason:
        typeof o.rejection_reason === "string" ? o.rejection_reason : null,
      purchaseId: p ? String(p.id) : null,
      purchaseStatus: p ? String(p.status ?? "pending") : "missing",
      planId: p && typeof p.plan_id === "string" ? p.plan_id : null,
      planSummary: `${presetName} · ${eventsTotal} event${eventsTotal === 1 ? "" : "s"} × ${certsPerEvent} certs (${months}m)`,
      eventsTotal,
      certsPerEvent,
      months,
      listPricePkr: p ? Number(p.list_price_pkr ?? 0) : 0,
      discountPkr: p ? Number(p.discount_pkr ?? 0) : 0,
      finalPricePkr: p ? Number(p.final_price_pkr ?? 0) : 0,
      isPilot: p ? Boolean(p.is_pilot) : false,
      paymentNote:
        p && typeof p.payment_note === "string" ? p.payment_note : null,
      reviewedBy:
        (p && typeof p.reviewed_by === "string" && p.reviewed_by) ||
        (typeof o.approved_by === "string" && o.approved_by) ||
        (typeof o.rejected_by === "string" && o.rejected_by) ||
        null,
      reviewedAt:
        (p && typeof p.reviewed_at === "string" && p.reviewed_at) ||
        (typeof o.approved_at === "string" && o.approved_at) ||
        (typeof o.rejected_at === "string" && o.rejected_at) ||
        null,
      createdAt: String(o.created_at ?? ""),
    });
  }

  return {
    requests,
    pendingCount,
    featureFlags: getFeatureFlags(),
  };
}

export async function getPlatformOverviewData(): Promise<PlatformOverviewData> {
  const admin = getSupabaseAdmin();
  const nowMs = Date.now();
  const in14DaysMs = nowMs + 14 * 86_400_000;

  const [
    { pricingConfig },
    orgsRes,
    eventsCountRes,
    releasedEventsRes,
    certsCountRes,
    downloadsCountRes,
    purchasesRes,
    topupsRes,
    auditRes,
  ] = await Promise.all([
    getPricingAndPresets(),
    admin.from("organizations").select("id, name, slug, status"),
    admin.from("events").select("id", { count: "exact", head: true }),
    admin
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("released", true),
    admin
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true }),
    admin.from("download_log").select("id", { count: "exact", head: true }),
    admin
      .from("purchases")
      .select(
        "id, org_id, kind, events_used, events_total, certs_per_event, final_price_pkr, is_pilot, status, expires_at, reviewed_at, created_at",
      ),
    admin
      .from("certificate_topups")
      .select("id, org_id, amount_pkr, status, reviewed_at, created_at"),
    admin
      .from("audit_log")
      .select("id, org_id, user_id, action, details, created_at, organizations(name)")
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const orgs = (orgsRes.data ?? []) as Array<Record<string, unknown>>;
  const orgLookup = new Map<
    string,
    { name: string; slug: string; status: SuperAdminOrgStatus }
  >();
  let activeOrgs = 0;
  let pendingOrgs = 0;
  let rejectedOrgs = 0;
  let suspendedOrgs = 0;
  for (const o of orgs) {
    const st = normalizeSuperOrgStatus(o.status);
    if (st === "suspended") suspendedOrgs++;
    else if (st === "pending") pendingOrgs++;
    else if (st === "rejected") rejectedOrgs++;
    else activeOrgs++;
    orgLookup.set(String(o.id), {
      name: String(o.name ?? ""),
      slug: String(o.slug ?? ""),
      status: st,
    });
  }

  const paidOrgSet = new Set<string>();
  const revenueItems: ApprovedPaymentForRevenue[] = [];
  let pendingPaymentsCount = 0;
  const expiringWithin14Days: ExpiringPurchaseOverviewItem[] = [];

  for (const p of (purchasesRes.data ?? []) as Array<Record<string, unknown>>) {
    const status = String(p.status ?? "pending");
    const orgId = String(p.org_id);
    const isPilot = Boolean(p.is_pilot);
    const expiresAt = typeof p.expires_at === "string" ? p.expires_at : null;

    if (status === "pending") {
      pendingPaymentsCount++;
    }

    if ((status === "active" || status === "expired") && !isPilot) {
      paidOrgSet.add(orgId);
      revenueItems.push({
        amountPkr: Number(p.final_price_pkr ?? 0),
        status: "approved",
        reviewedAt: typeof p.reviewed_at === "string" ? p.reviewed_at : null,
        createdAt: String(p.created_at ?? ""),
      });
    }

    if (status === "active" && expiresAt) {
      const expTs = Date.parse(expiresAt);
      const orgMeta = orgLookup.get(orgId);
      if (
        Number.isFinite(expTs) &&
        expTs > nowMs &&
        expTs <= in14DaysMs &&
        orgMeta?.status === "active"
      ) {
        expiringWithin14Days.push({
          purchaseId: String(p.id),
          orgId,
          orgName: orgMeta.name,
          orgSlug: orgMeta.slug,
          kind: String(p.kind ?? "custom"),
          eventsUsed: Number(p.events_used ?? 0),
          eventsTotal: Number(p.events_total ?? 1),
          certsPerEvent: Number(p.certs_per_event ?? 50),
          isPilot,
          expiresAt,
          daysRemaining: Math.max(1, Math.ceil((expTs - nowMs) / 86_400_000)),
        });
      }
    }
  }

  expiringWithin14Days.sort(
    (a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt),
  );

  for (const t of (topupsRes.data ?? []) as Array<Record<string, unknown>>) {
    const status = String(t.status ?? "pending");
    if (status === "pending") {
      pendingPaymentsCount++;
    } else if (status === "approved") {
      paidOrgSet.add(String(t.org_id));
      revenueItems.push({
        amountPkr: Number(t.amount_pkr ?? 0),
        status: "approved",
        reviewedAt: typeof t.reviewed_at === "string" ? t.reviewed_at : null,
        createdAt: String(t.created_at ?? ""),
      });
    }
  }

  const revenueSummary = buildMonthlyRevenueSeries(revenueItems, 6);

  const recentAuditLogs: PlatformAuditLogItem[] = (
    (auditRes.data ?? []) as Array<Record<string, unknown>>
  ).map((row) => {
    const orgRel = Array.isArray(row.organizations)
      ? (row.organizations[0] as Record<string, unknown> | undefined)
      : (row.organizations as Record<string, unknown> | undefined);
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      orgName: String(orgRel?.name ?? row.org_id),
      userId: typeof row.user_id === "string" ? row.user_id : null,
      action: String(row.action),
      details:
        row.details && typeof row.details === "object"
          ? (row.details as Record<string, unknown>)
          : {},
      createdAt: String(row.created_at ?? ""),
    };
  });

  return {
    totalOrgs: orgs.length,
    activeOrgs,
    pendingOrgs,
    rejectedOrgs,
    suspendedOrgs,
    paidOrgs: paidOrgSet.size,
    totalEvents: eventsCountRes.count ?? 0,
    releasedEvents: releasedEventsRes.count ?? 0,
    totalCertificatesIssued: certsCountRes.count ?? 0,
    totalDownloads: downloadsCountRes.count ?? 0,
    pendingPaymentsCount,
    totalApprovedRevenuePkr: revenueSummary.totalApprovedRevenuePkr,
    totalApprovedRequests: revenueSummary.totalApprovedRequests,
    monthlyRevenue: revenueSummary.series,
    expiringWithin14Days,
    pricingConfig,
    recentAuditLogs,
  };
}

export async function getSuperAdminOrganizationsData(): Promise<{
  organizations: SuperAdminOrgRow[];
  presets: PricedPlanPreset[];
}> {
  const admin = getSupabaseAdmin();
  const nowMs = Date.now();

  const [
    { presets },
    orgsRes,
    purchasesRes,
    eventsRes,
    certsRes,
    dlRes,
    membersDir,
  ] = await Promise.all([
    getPricingAndPresets(),
    admin
      .from("organizations")
      .select("*")
      .order("created_at", { ascending: false }),
    admin
      .from("purchases")
      .select("org_id, kind, is_pilot, status, expires_at")
      .order("expires_at", { ascending: true }),
    admin.from("events").select("org_id"),
    admin.from("attendee_certificates").select("org_id"),
    admin.from("download_log").select("org_id"),
    fetchMembersAuthDirectory(),
  ]);

  const purchasesByOrg = new Map<string, Array<Record<string, unknown>>>();
  for (const p of (purchasesRes.data ?? []) as Array<Record<string, unknown>>) {
    const oid = String(p.org_id);
    const list = purchasesByOrg.get(oid) ?? [];
    list.push(p);
    purchasesByOrg.set(oid, list);
  }

  const eventsByOrg = new Map<string, number>();
  for (const e of (eventsRes.data ?? []) as Array<{ org_id: string }>) {
    eventsByOrg.set(e.org_id, (eventsByOrg.get(e.org_id) ?? 0) + 1);
  }

  const certsByOrg = new Map<string, number>();
  for (const c of (certsRes.data ?? []) as Array<{ org_id: string }>) {
    certsByOrg.set(c.org_id, (certsByOrg.get(c.org_id) ?? 0) + 1);
  }

  const dlByOrg = new Map<string, number>();
  for (const d of (dlRes.data ?? []) as Array<{ org_id: string }>) {
    dlByOrg.set(d.org_id, (dlByOrg.get(d.org_id) ?? 0) + 1);
  }

  const organizations: SuperAdminOrgRow[] = (
    (orgsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((o) => {
    const orgId = String(o.id);
    const orgMembers = membersDir.byOrg?.get(orgId) ?? [];
    const orgPurchases = purchasesByOrg.get(orgId) ?? [];
    const status = normalizeSuperOrgStatus(o.status);

    const activeUnexp = orgPurchases.filter(
      (p) =>
        p.status === "active" &&
        !isPlanExpired(
          typeof p.expires_at === "string" ? p.expires_at : null,
          nowMs,
        ),
    );
    const pendingList = orgPurchases.filter((p) => p.status === "pending");

    let planId = "none";
    let planName = "No Package";
    let planExpiresAt: string | null = null;

    if (activeUnexp.length > 0) {
      const p0 = activeUnexp[0];
      planId = p0.is_pilot ? "pilot" : String(p0.kind ?? "custom");
      planName =
        activeUnexp.length > 1
          ? `${activeUnexp.length} Active`
          : p0.is_pilot
            ? "Pilot"
            : String(p0.kind ?? "Active").toUpperCase();
      planExpiresAt =
        typeof p0.expires_at === "string" ? p0.expires_at : null;
    } else if (pendingList.length > 0 || status === "pending") {
      planId = "pending";
      planName = "Pending";
    } else if (status === "rejected") {
      planId = "rejected";
      planName = "Rejected";
    } else if (orgPurchases.length > 0) {
      planId = "expired";
      planName = "Expired";
      const last = orgPurchases[orgPurchases.length - 1];
      planExpiresAt =
        typeof last?.expires_at === "string" ? last.expires_at : null;
    }

    let lastLoginAt: string | null = null;
    let ownerEmail: string | null =
      typeof o.contact_email === "string" && o.contact_email
        ? o.contact_email
        : null;
    for (const m of orgMembers) {
      if (m.role === "owner" && m.email && !ownerEmail) {
        ownerEmail = m.email;
      } else if (m.email && !ownerEmail) {
        ownerEmail = m.email;
      }
      if (m.lastSignInAt && (!lastLoginAt || m.lastSignInAt > lastLoginAt)) {
        lastLoginAt = m.lastSignInAt;
      }
    }

    return {
      id: orgId,
      name: String(o.name ?? ""),
      slug: String(o.slug ?? ""),
      planId,
      planName,
      status,
      planExpiresAt,
      eventsCount: eventsByOrg.get(orgId) ?? 0,
      certificatesIssuedCount: certsByOrg.get(orgId) ?? 0,
      downloadsCount: dlByOrg.get(orgId) ?? 0,
      memberCount: orgMembers.length,
      ownerEmail,
      lastLoginAt,
      createdAt: String(o.created_at ?? ""),
    };
  });

  return { organizations, presets };
}

export async function getSuperAdminOrganizationDetailData(
  orgId: string,
): Promise<SuperAdminOrgDetailData | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      orgId,
    )
  ) {
    return null;
  }

  const admin = getSupabaseAdmin();
  const { data: orgRow, error } = await admin
    .from("organizations")
    .select("*")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !orgRow) return null;
  const o = orgRow as Record<string, unknown>;
  const nowMs = Date.now();

  const [
    { presets },
    membersDir,
    eventsRes,
    attendeesCountRes,
    certsRes,
    downloadsCountRes,
    purchasesRes,
    topupsRes,
    auditRes,
  ] = await Promise.all([
    getPricingAndPresets(),
    fetchMembersAuthDirectory(orgId),
    admin
      .from("events")
      .select(
        "id, title, slug, released, max_certificates, retention_until, event_date, created_at, attendees(count)",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    admin
      .from("attendees")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    admin
      .from("attendee_certificates")
      .select("id, event_id, download_count")
      .eq("org_id", orgId),
    admin
      .from("download_log")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    admin
      .from("purchases")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    admin
      .from("certificate_topups")
      .select("*, events(title)")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    admin
      .from("audit_log")
      .select("id, org_id, user_id, action, details, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const purchases = (
    (purchasesRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapPurchaseRow(r, nowMs));

  const activePurchases = purchases.filter(
    (p) => p.effectiveStatus === "active",
  );
  const eventsSlotsUsed = activePurchases.reduce(
    (s, p) => s + p.eventsUsed,
    0,
  );
  const eventsSlotsTotal = activePurchases.reduce(
    (s, p) => s + p.eventsTotal,
    0,
  );

  const certsByEvent = new Map<string, { issued: number; downloads: number }>();
  for (const c of (certsRes.data ?? []) as Array<{
    event_id: string;
    download_count: number;
  }>) {
    const cur = certsByEvent.get(c.event_id) ?? { issued: 0, downloads: 0 };
    cur.issued += 1;
    cur.downloads += Number(c.download_count ?? 0);
    certsByEvent.set(c.event_id, cur);
  }

  const events: SuperAdminEventRow[] = (
    (eventsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((ev) => {
    const evId = String(ev.id);
    const attRel = ev.attendees as
      | Array<{ count?: number }>
      | { count?: number }
      | null;
    const attendeeCount = Array.isArray(attRel)
      ? Number(attRel[0]?.count ?? 0)
      : Number(attRel?.count ?? 0);
    const cStats = certsByEvent.get(evId) ?? { issued: 0, downloads: 0 };

    return {
      id: evId,
      title: String(ev.title ?? ""),
      slug: String(ev.slug ?? ""),
      released: Boolean(ev.released),
      maxCertificates: Math.max(1, Number(ev.max_certificates ?? 50)),
      retentionUntil:
        typeof ev.retention_until === "string" ? ev.retention_until : null,
      eventDate: typeof ev.event_date === "string" ? ev.event_date : null,
      attendeeCount,
      certificatesIssuedCount: cStats.issued,
      downloadsCount: cStats.downloads,
      createdAt: String(ev.created_at ?? ""),
    };
  });

  const eventTitleById = new Map(events.map((e) => [e.id, e.title]));
  const topups = (
    (topupsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapTopupRow(r, eventTitleById));

  const orgStatus = normalizeSuperOrgStatus(o.status);

  const packageLabel =
    activePurchases.length > 0
      ? activePurchases[0].isPilot
        ? "Pilot Package"
        : `${activePurchases[0].kind.toUpperCase()} Package`
      : purchases.some((p) => p.status === "pending") || orgStatus === "pending"
        ? "Pending Approval"
        : orgStatus === "rejected"
          ? "Rejected"
          : purchases.length > 0
            ? "Expired"
            : "No Package";

  const soonestExp =
    activePurchases[0]?.expiresAt ?? purchases[0]?.expiresAt ?? null;

  const auditLogs: PlatformAuditLogItem[] = (
    (auditRes.data ?? []) as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row.id),
    orgId,
    orgName: String(o.name ?? ""),
    userId: typeof row.user_id === "string" ? row.user_id : null,
    action: String(row.action),
    details:
      row.details && typeof row.details === "object"
        ? (row.details as Record<string, unknown>)
        : {},
    createdAt: String(row.created_at ?? ""),
  }));

  return {
    org: {
      id: orgId,
      name: String(o.name ?? ""),
      slug: String(o.slug ?? ""),
      planId: String(o.plan_id ?? "none"),
      packageLabel,
      status: orgStatus,
      contactName: typeof o.contact_name === "string" ? o.contact_name : null,
      contactEmail:
        typeof o.contact_email === "string" ? o.contact_email : null,
      whatsappNumber:
        typeof o.whatsapp_number === "string" ? o.whatsapp_number : null,
      rejectionReason:
        typeof o.rejection_reason === "string" ? o.rejection_reason : null,
      planExpiresAt: soonestExp,
      planExpiringSoon: Boolean(o.plan_expiring_soon),
      createdAt: String(o.created_at ?? ""),
      updatedAt: String(o.updated_at ?? o.created_at ?? ""),
    },
    presets,
    usage: {
      eventsCount: events.length,
      eventsSlotsUsed,
      eventsSlotsTotal,
      attendeesCount: attendeesCountRes.count ?? 0,
      certificatesIssuedCount: (certsRes.data ?? []).length,
      downloadsCount: downloadsCountRes.count ?? 0,
    },
    members: membersDir,
    events,
    purchases,
    topups,
    auditLogs,
  };
}

export async function getSuperAdminPaymentsQueueData(): Promise<SuperAdminPaymentsQueueData> {
  const admin = getSupabaseAdmin();
  const nowMs = Date.now();

  const [purchasesRes, topupsRes] = await Promise.all([
    admin
      .from("purchases")
      .select("*, organizations(name)")
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("certificate_topups")
      .select("*, organizations(name), events(title)")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const purchases = (
    (purchasesRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapPurchaseRow(r, nowMs));

  const topups = (
    (topupsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapTopupRow(r, new Map()));

  return { purchases, topups };
}
