import "server-only";

import type { PlanDetails, PaymentMethod, PaymentRequestStatus } from "@/lib/dashboard-data";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  buildMonthlyRevenueSeries,
  type MonthlyRevenuePoint,
  type SuperAdminOrgRow,
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

export interface PlatformOverviewData {
  totalOrgs: number;
  activeOrgs: number;
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
  recentAuditLogs: PlatformAuditLogItem[];
}

export interface SuperAdminPaymentRow {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgStatus: "active" | "suspended";
  planId: string;
  planName: string;
  amountPkr: number;
  paymentMethod: PaymentMethod;
  transactionReference: string;
  hasScreenshot: boolean;
  status: PaymentRequestStatus;
  billingDays: number;
  reviewerNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
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
    status: "active" | "suspended";
    planExpiresAt: string | null;
    planExpiringSoon: boolean;
    createdAt: string;
    updatedAt: string;
  };
  currentPlan: PlanDetails;
  allPlans: PlanDetails[];
  usage: {
    eventsCount: number;
    attendeesCount: number;
    certificatesIssuedCount: number;
    downloadsCount: number;
  };
  members: SuperAdminMemberRow[];
  events: SuperAdminEventRow[];
  paymentRequests: SuperAdminPaymentRow[];
  auditLogs: PlatformAuditLogItem[];
}

function mapPlan(p: Record<string, unknown>): PlanDetails {
  return {
    id: String(p.id ?? "free"),
    name: String(p.name ?? p.id ?? "Free"),
    maxEvents: (p.max_events as number | null) ?? null,
    maxCertificatesPerEvent:
      (p.max_certificates_per_event as number | null) ?? null,
    maxCertificatesTotal: (p.max_certificates_total as number | null) ?? null,
    maxCertificateTypesPerEvent:
      p.max_certificate_types_per_event === undefined
        ? null
        : ((p.max_certificate_types_per_event as number | null) ?? null),
    allowCustomBranding: Boolean(p.allow_custom_branding),
    pricePkr: Number(p.price_pkr ?? 0),
  };
}

async function fetchMembersAuthDirectory(
  targetOrgId?: string,
): Promise<SuperAdminMemberRow[] & { byOrg?: Map<string, SuperAdminMemberRow[]> }> {
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

  // Fallback if 012 RPC hasn't been executed yet: read organization_members + auth.admin.listUsers
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

export async function getPlatformOverviewData(): Promise<PlatformOverviewData> {
  const admin = getSupabaseAdmin();

  const [
    orgsRes,
    eventsCountRes,
    releasedEventsRes,
    certsCountRes,
    downloadsCountRes,
    paymentsRes,
    auditRes,
  ] = await Promise.all([
    admin.from("organizations").select("id, name, status, plan_id"),
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
      .from("payment_requests")
      .select("amount_pkr, status, reviewed_at, created_at"),
    admin
      .from("audit_log")
      .select("id, org_id, user_id, action, details, created_at, organizations(name)")
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const orgs = (orgsRes.data ?? []) as Array<Record<string, unknown>>;
  let activeOrgs = 0;
  let suspendedOrgs = 0;
  let paidOrgs = 0;
  for (const o of orgs) {
    if (o.status === "suspended") suspendedOrgs++;
    else activeOrgs++;
    if (o.plan_id && o.plan_id !== "free") paidOrgs++;
  }

  const rawPayments = (paymentsRes.data ?? []) as Array<Record<string, unknown>>;
  let pendingPaymentsCount = 0;
  const formattedPayments = rawPayments.map((p) => {
    const st = (["pending", "approved", "rejected"].includes(String(p.status))
      ? String(p.status)
      : "pending") as "pending" | "approved" | "rejected";
    if (st === "pending") pendingPaymentsCount++;
    return {
      amountPkr: Number(p.amount_pkr ?? 0),
      status: st,
      reviewedAt: typeof p.reviewed_at === "string" ? p.reviewed_at : null,
      createdAt: String(p.created_at ?? ""),
    };
  });

  const revenueSummary = buildMonthlyRevenueSeries(formattedPayments, 6);

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
    suspendedOrgs,
    paidOrgs,
    totalEvents: eventsCountRes.count ?? 0,
    releasedEvents: releasedEventsRes.count ?? 0,
    totalCertificatesIssued: certsCountRes.count ?? 0,
    totalDownloads: downloadsCountRes.count ?? 0,
    pendingPaymentsCount,
    totalApprovedRevenuePkr: revenueSummary.totalApprovedRevenuePkr,
    totalApprovedRequests: revenueSummary.totalApprovedRequests,
    monthlyRevenue: revenueSummary.series,
    recentAuditLogs,
  };
}

export async function getSuperAdminOrganizationsData(): Promise<{
  organizations: SuperAdminOrgRow[];
  plans: PlanDetails[];
}> {
  const admin = getSupabaseAdmin();

  const [plansRes, orgsRes, eventsRes, certsRes, dlRes, membersDir] =
    await Promise.all([
      admin.from("plans").select("*").order("price_pkr", { ascending: true }),
      admin
        .from("organizations")
        .select("*")
        .order("created_at", { ascending: false }),
      admin.from("events").select("org_id"),
      admin.from("attendee_certificates").select("org_id"),
      admin.from("download_log").select("org_id"),
      fetchMembersAuthDirectory(),
    ]);

  const plans = ((plansRes.data ?? []) as Array<Record<string, unknown>>).map(
    mapPlan,
  );
  const planNameById = new Map(plans.map((p) => [p.id, p.name]));

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
    const planId = String(o.plan_id ?? "free");
    const orgMembers = membersDir.byOrg?.get(orgId) ?? [];

    let lastLoginAt: string | null = null;
    let ownerEmail: string | null = null;
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
      planName: planNameById.get(planId) ?? planId,
      status: o.status === "suspended" ? "suspended" : "active",
      planExpiresAt:
        typeof o.plan_expires_at === "string" ? o.plan_expires_at : null,
      eventsCount: eventsByOrg.get(orgId) ?? 0,
      certificatesIssuedCount: certsByOrg.get(orgId) ?? 0,
      downloadsCount: dlByOrg.get(orgId) ?? 0,
      memberCount: orgMembers.length,
      ownerEmail,
      lastLoginAt,
      createdAt: String(o.created_at ?? ""),
    };
  });

  return { organizations, plans };
}

export async function getSuperAdminOrganizationDetailData(
  orgId: string,
): Promise<SuperAdminOrgDetailData | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
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
  const planId = String(o.plan_id ?? "free");

  const [
    plansRes,
    membersDir,
    eventsRes,
    attendeesCountRes,
    certsRes,
    downloadsCountRes,
    payReqsRes,
    auditRes,
  ] = await Promise.all([
    admin.from("plans").select("*").order("price_pkr", { ascending: true }),
    fetchMembersAuthDirectory(orgId),
    admin
      .from("events")
      .select("id, title, slug, released, event_date, created_at, attendees(count)")
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
      .from("payment_requests")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    admin
      .from("audit_log")
      .select("id, org_id, user_id, action, details, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const allPlans = (
    (plansRes.data ?? []) as Array<Record<string, unknown>>
  ).map(mapPlan);
  const planNameById = new Map(allPlans.map((p) => [p.id, p.name]));
  const currentPlan =
    allPlans.find((p) => p.id === planId) ??
    allPlans[0] ?? {
      id: planId,
      name: planId,
      maxEvents: 1,
      maxCertificatesPerEvent: 50,
      maxCertificatesTotal: 50,
      maxCertificateTypesPerEvent: 3,
      allowCustomBranding: false,
      pricePkr: 0,
    };

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
      eventDate: typeof ev.event_date === "string" ? ev.event_date : null,
      attendeeCount,
      certificatesIssuedCount: cStats.issued,
      downloadsCount: cStats.downloads,
      createdAt: String(ev.created_at ?? ""),
    };
  });

  const orgStatus: "active" | "suspended" =
    o.status === "suspended" ? "suspended" : "active";

  const paymentRequests: SuperAdminPaymentRow[] = (
    (payReqsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => {
    const rPlanId = String(r.plan_id ?? "starter");
    return {
      id: String(r.id),
      orgId,
      orgName: String(o.name ?? ""),
      orgSlug: String(o.slug ?? ""),
      orgStatus,
      planId: rPlanId,
      planName: planNameById.get(rPlanId) ?? rPlanId,
      amountPkr: Number(r.amount_pkr ?? 0),
      paymentMethod: (["bank", "jazzcash", "easypaisa"].includes(
        String(r.payment_method),
      )
        ? String(r.payment_method)
        : "bank") as PaymentMethod,
      transactionReference: String(r.transaction_reference ?? ""),
      hasScreenshot: Boolean(r.screenshot_path),
      status: (["pending", "approved", "rejected"].includes(String(r.status))
        ? String(r.status)
        : "pending") as PaymentRequestStatus,
      billingDays: Number(r.billing_days ?? 30),
      reviewerNote:
        typeof r.reviewer_note === "string" ? r.reviewer_note : null,
      reviewedBy: typeof r.reviewed_by === "string" ? r.reviewed_by : null,
      reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
      createdAt: String(r.created_at ?? ""),
    };
  });

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
      planId,
      status: orgStatus,
      planExpiresAt:
        typeof o.plan_expires_at === "string" ? o.plan_expires_at : null,
      planExpiringSoon: Boolean(o.plan_expiring_soon),
      createdAt: String(o.created_at ?? ""),
      updatedAt: String(o.updated_at ?? o.created_at ?? ""),
    },
    currentPlan,
    allPlans,
    usage: {
      eventsCount: events.length,
      attendeesCount: attendeesCountRes.count ?? 0,
      certificatesIssuedCount: (certsRes.data ?? []).length,
      downloadsCount: downloadsCountRes.count ?? 0,
    },
    members: membersDir,
    events,
    paymentRequests,
    auditLogs,
  };
}

export async function getSuperAdminPaymentRequestsData(): Promise<
  SuperAdminPaymentRow[]
> {
  const admin = getSupabaseAdmin();
  const [plansRes, reqsRes] = await Promise.all([
    admin.from("plans").select("id, name"),
    admin
      .from("payment_requests")
      .select("*, organizations(id, name, slug, status)")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const planNameById = new Map<string, string>();
  for (const p of (plansRes.data ?? []) as Array<{ id: string; name: string }>) {
    planNameById.set(p.id, p.name);
  }

  return ((reqsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const orgRel = Array.isArray(r.organizations)
      ? (r.organizations[0] as Record<string, unknown> | undefined)
      : (r.organizations as Record<string, unknown> | undefined);
    const planId = String(r.plan_id ?? "starter");

    return {
      id: String(r.id),
      orgId: String(r.org_id),
      orgName: String(orgRel?.name ?? r.org_id),
      orgSlug: String(orgRel?.slug ?? ""),
      orgStatus: orgRel?.status === "suspended" ? "suspended" : "active",
      planId,
      planName: planNameById.get(planId) ?? planId,
      amountPkr: Number(r.amount_pkr ?? 0),
      paymentMethod: (["bank", "jazzcash", "easypaisa"].includes(
        String(r.payment_method),
      )
        ? String(r.payment_method)
        : "bank") as PaymentMethod,
      transactionReference: String(r.transaction_reference ?? ""),
      hasScreenshot: Boolean(r.screenshot_path),
      status: (["pending", "approved", "rejected"].includes(String(r.status))
        ? String(r.status)
        : "pending") as PaymentRequestStatus,
      billingDays: Number(r.billing_days ?? 30),
      reviewerNote:
        typeof r.reviewer_note === "string" ? r.reviewer_note : null,
      reviewedBy: typeof r.reviewed_by === "string" ? r.reviewed_by : null,
      reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
      createdAt: String(r.created_at ?? ""),
    };
  });
}
