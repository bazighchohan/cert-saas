import "server-only";

import { cache } from "react";
import { requireDashboardAuth, type CurrentOrg, type CurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface PlanDetails {
  id: string;
  name: string;
  maxEvents: number | null;
  maxCertificatesPerEvent: number | null;
  maxCertificatesTotal: number | null;
  maxCertificateTypesPerEvent: number | null;
  allowCustomBranding: boolean;
  pricePkr: number;
}

export interface OrgUsageSummary {
  org: CurrentOrg;
  user: CurrentUser;
  plan: PlanDetails;
  eventsUsed: number;
  certificatesUsed: number;
}

export type PaymentMethod = "bank" | "jazzcash" | "easypaisa";
export type PaymentRequestStatus = "pending" | "approved" | "rejected";

export interface PaymentRequestRow {
  id: string;
  orgId: string;
  orgName?: string;
  planId: string;
  planName: string;
  amountPkr: number;
  paymentMethod: PaymentMethod;
  transactionReference: string;
  hasScreenshot: boolean;
  status: PaymentRequestStatus;
  billingDays: number;
  reviewerNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface BillingDashboardData extends OrgUsageSummary {
  allPlans: PlanDetails[];
  paymentRequests: PaymentRequestRow[];
  isSuperAdmin: boolean;
  adminPendingRequests: PaymentRequestRow[];
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.SUPER_ADMIN_EMAILS || "";
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export interface CertificateTypeRow {
  id: string;
  orgId: string;
  eventId: string;
  key: string;
  label: string;
  templatePath: string | null;
  templateMime: "application/pdf" | "image/png" | "image/jpeg" | null;
  pageWidthPt: number | null;
  pageHeightPt: number | null;
  pageCount: number;
  pageIndex: number;
  nameX: number;
  nameY: number;
  nameFont: string;
  nameBold: boolean;
  nameSize: number;
  nameColor: string;
  nameAlign: "left" | "center" | "right";
  maxNameWidth: number;
  updatedAt: string;
}

export interface EventSummaryRow {
  id: string;
  orgId: string;
  title: string;
  subtitle: string | null;
  slug: string;
  eventDate: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  released: boolean;
  identifierLabel: string;
  uppercaseIdentifiers: boolean;
  requireNameMatch: boolean;
  downloadLimit: number | null;
  showQr: boolean;
  qrPosition: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "custom";
  qrSize: number;
  createdAt: string;
  updatedAt: string;
  attendeeCount: number;
}

export interface EventDetail extends EventSummaryRow {
  certificateTypes: CertificateTypeRow[];
  certificateTypesCount: number;
  maxCertificateTypesPerEvent: number | null;
  planName: string;
  certificatesIssuedCount: number;
  certificatesDownloadedCount: number;
}

const DEFAULT_FREE_PLAN: PlanDetails = {
  id: "free",
  name: "Free",
  maxEvents: 1,
  maxCertificatesPerEvent: 50,
  maxCertificatesTotal: 50,
  maxCertificateTypesPerEvent: 3,
  allowCustomBranding: false,
  pricePkr: 0,
};

/**
 * Loads the current organization's active plan details and current usage
 * (events count & issued certificates count), strictly scoped via getCurrentOrg().
 */
export const getOrgPlanAndUsage = cache(async (): Promise<OrgUsageSummary> => {
  const { user, org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const [planRes, eventsCountRes, certsCountRes] = await Promise.all([
    supabase
      .from("plans")
      .select("*")
      .eq("id", org.planId)
      .maybeSingle(),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);

  const p = planRes.data as Record<string, unknown> | null;
  const plan: PlanDetails = p
    ? {
        id: p.id as string,
        name: p.name as string,
        maxEvents: (p.max_events as number | null) ?? null,
        maxCertificatesPerEvent:
          (p.max_certificates_per_event as number | null) ?? null,
        maxCertificatesTotal:
          (p.max_certificates_total as number | null) ?? null,
        maxCertificateTypesPerEvent:
          p.max_certificate_types_per_event === undefined
            ? 3
            : ((p.max_certificate_types_per_event as number | null) ?? null),
        allowCustomBranding: Boolean(p.allow_custom_branding),
        pricePkr: Number(p.price_pkr ?? 0),
      }
    : { ...DEFAULT_FREE_PLAN, id: org.planId };

  return {
    org,
    user,
    plan,
    eventsUsed: eventsCountRes.count ?? 0,
    certificatesUsed: certsCountRes.count ?? 0,
  };
});

function mapEventRow(row: Record<string, unknown>): EventSummaryRow {
  const attendeesRel = row.attendees as
    | Array<{ count?: number }>
    | { count?: number }
    | null;
  const attendeeCount = Array.isArray(attendeesRel)
    ? Number(attendeesRel[0]?.count ?? 0)
    : Number(attendeesRel?.count ?? 0);

  return {
    id: row.id as string,
    orgId: row.org_id as string,
    title: row.title as string,
    subtitle: (row.subtitle as string | null) ?? null,
    slug: row.slug as string,
    eventDate: (row.event_date as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    released: Boolean(row.released),
    identifierLabel: (row.identifier_label as string) ?? "Registration number",
    uppercaseIdentifiers:
      row.uppercase_identifiers === undefined
        ? true
        : Boolean(row.uppercase_identifiers),
    requireNameMatch: Boolean(row.require_name_match),
    downloadLimit:
      row.download_limit === null || row.download_limit === undefined
        ? null
        : Number(row.download_limit),
    showQr: Boolean(row.show_qr ?? false),
    qrPosition: ([
      "bottom-right",
      "bottom-left",
      "top-right",
      "top-left",
      "custom",
    ].includes(String(row.qr_position))
      ? String(row.qr_position)
      : "bottom-right") as
      | "bottom-right"
      | "bottom-left"
      | "top-right"
      | "top-left"
      | "custom",
    qrSize:
      row.qr_size !== null && row.qr_size !== undefined
        ? Number(row.qr_size)
        : 54,
    createdAt: row.created_at as string,
    updatedAt: (row.updated_at as string) ?? (row.created_at as string),
    attendeeCount,
  };
}

function mapCertificateTypeRow(row: Record<string, unknown>): CertificateTypeRow {
  const pageWidthPt =
    row.page_width_pt !== null && row.page_width_pt !== undefined
      ? Number(row.page_width_pt)
      : null;
  const pageHeightPt =
    row.page_height_pt !== null && row.page_height_pt !== undefined
      ? Number(row.page_height_pt)
      : null;

  const wRef = pageWidthPt ?? 843.75;
  const hRef = pageHeightPt ?? 597.75;
  const rawX = Number(row.name_x ?? 421.88);
  const rawY = Number(row.name_y ?? 265);
  const rawMaxW = Number(row.max_name_width ?? 464);

  return {
    id: row.id as string,
    orgId: row.org_id as string,
    eventId: row.event_id as string,
    key: row.key as string,
    label: row.label as string,
    templatePath: (row.template_path as string | null) ?? null,
    templateMime:
      (row.template_mime as
        | "application/pdf"
        | "image/png"
        | "image/jpeg"
        | null) ?? null,
    pageWidthPt,
    pageHeightPt,
    pageCount:
      row.page_count !== null && row.page_count !== undefined
        ? Number(row.page_count)
        : 1,
    pageIndex: Number(row.page_index ?? 0),
    nameX: rawX <= 1 ? Number((wRef * rawX).toFixed(2)) : rawX,
    nameY: rawY <= 1 ? Number((hRef * (1 - rawY)).toFixed(2)) : rawY,
    nameFont: (row.name_font as string) ?? "times",
    nameBold: row.name_bold === undefined ? true : Boolean(row.name_bold),
    nameSize: Number(row.name_size ?? 34),
    nameColor: (row.name_color as string) ?? "#0B2A4F",
    nameAlign: ((row.name_align as string) ?? "center") as
      | "left"
      | "center"
      | "right",
    maxNameWidth: rawMaxW <= 1 ? Number((wRef * rawMaxW).toFixed(2)) : rawMaxW,
    updatedAt: (row.updated_at as string) ?? (row.created_at as string),
  };
}

/**
 * Lists all events belonging to the current organization (getCurrentOrg()).
 */
export const getOrgEvents = cache(async (): Promise<EventSummaryRow[]> => {
  const { org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("events")
    .select("*, attendees(count)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data.map((row) => mapEventRow(row as Record<string, unknown>));
});

/**
 * Fetches a single event by id ONLY if it belongs to getCurrentOrg().
 * Returns null if the event does not exist or belongs to another organization.
 */
export async function getOrgEventById(
  eventId: string,
): Promise<EventDetail | null> {
  const { org } = await requireDashboardAuth();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("events")
    .select("*, attendees(count)")
    .eq("id", eventId)
    .eq("org_id", org.id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const [usage, typesRes, issuedRes, downloadedRes] = await Promise.all([
    getOrgPlanAndUsage(),
    supabase
      .from("certificate_types")
      .select("*")
      .eq("org_id", org.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: true }),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("event_id", eventId),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("event_id", eventId)
      .gt("download_count", 0),
  ]);

  const certificateTypes = (typesRes.data ?? []).map((row) =>
    mapCertificateTypeRow(row as Record<string, unknown>),
  );

  const base = mapEventRow(data as Record<string, unknown>);
  return {
    ...base,
    certificateTypes,
    certificateTypesCount: certificateTypes.length,
    maxCertificateTypesPerEvent: usage.plan.maxCertificateTypesPerEvent,
    planName: usage.plan.name,
    certificatesIssuedCount: issuedRes.count ?? 0,
    certificatesDownloadedCount: downloadedRes.count ?? 0,
  };
}

function mapPlanRow(p: Record<string, unknown>): PlanDetails {
  return {
    id: p.id as string,
    name: p.name as string,
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

function mapPaymentRequestRow(
  r: Record<string, unknown>,
  planNameById: Map<string, string>,
): PaymentRequestRow {
  const planId = (r.plan_id as string) || "starter";
  const orgRel = Array.isArray(r.organizations)
    ? (r.organizations[0] as Record<string, unknown> | undefined)
    : (r.organizations as Record<string, unknown> | undefined);

  return {
    id: r.id as string,
    orgId: r.org_id as string,
    orgName: typeof orgRel?.name === "string" ? orgRel.name : undefined,
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
    reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
  };
}

export async function getBillingDashboardData(): Promise<BillingDashboardData> {
  const usage = await getOrgPlanAndUsage();
  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();
  const superAdmin = isSuperAdminEmail(usage.user.email);

  const [plansRes, orgReqsRes, adminReqsRes] = await Promise.all([
    supabase
      .from("plans")
      .select("*")
      .eq("active", true)
      .order("price_pkr", { ascending: true }),
    supabase
      .from("payment_requests")
      .select("*")
      .eq("org_id", usage.org.id)
      .order("created_at", { ascending: false })
      .limit(25),
    superAdmin
      ? admin
          .from("payment_requests")
          .select("*, organizations(name)")
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(50)
      : Promise.resolve({ data: null, error: null }),
  ]);

  const allPlans =
    plansRes.data && plansRes.data.length > 0
      ? plansRes.data.map((row) => mapPlanRow(row as Record<string, unknown>))
      : [DEFAULT_FREE_PLAN];

  const planNameById = new Map(allPlans.map((p) => [p.id, p.name]));

  const paymentRequests = (orgReqsRes.data ?? []).map((row) =>
    mapPaymentRequestRow(row as Record<string, unknown>, planNameById),
  );

  const adminPendingRequests = (adminReqsRes.data ?? []).map((row) =>
    mapPaymentRequestRow(row as Record<string, unknown>, planNameById),
  );

  return {
    ...usage,
    allPlans,
    paymentRequests,
    isSuperAdmin: superAdmin,
    adminPendingRequests,
  };
}
