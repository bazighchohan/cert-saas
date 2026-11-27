import "server-only";

import { cache } from "react";
import { requireDashboardAuth, type CurrentOrg, type CurrentUser } from "@/lib/auth";
import {
  isPlanExpired,
  sortActiveUnexpiredPurchases,
  type PurchaseStatus,
} from "@/lib/plan-enforcement-helpers";
import {
  type PackageKind,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";
import { getPricingAndPresets } from "@/lib/pricing-server";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PaymentMethod = "bank" | "jazzcash" | "easypaisa" | "pilot" | "manual";

export interface PurchaseRow {
  id: string;
  orgId: string;
  orgName?: string;
  planId: string | null;
  kind: PackageKind;
  eventsTotal: number;
  eventsUsed: number;
  eventsRemaining: number;
  certsPerEvent: number;
  months: number;
  listPricePkr: number;
  discountPkr: number;
  finalPricePkr: number;
  isPilot: boolean;
  paymentMethod: PaymentMethod | null;
  transactionReference: string | null;
  hasScreenshot: boolean;
  paymentNote: string | null;
  status: PurchaseStatus;
  effectiveStatus: PurchaseStatus;
  startsAt: string | null;
  expiresAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CertificateTopupRow {
  id: string;
  orgId: string;
  orgName?: string;
  eventId: string;
  eventTitle: string;
  certsAdded: number;
  certRatePkr: number;
  amountPkr: number;
  paymentMethod: PaymentMethod | null;
  transactionReference: string | null;
  hasScreenshot: boolean;
  paymentNote: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CreateEventBlockInfo {
  code:
    | "PURCHASE_PENDING"
    | "NO_ACTIVE_PURCHASE"
    | "NO_EVENT_SLOTS"
    | "PURCHASE_EXPIRED";
  message: string;
}

export interface OrgUsageSummary {
  org: CurrentOrg;
  user: CurrentUser;
  purchases: PurchaseRow[];
  activePurchases: PurchaseRow[];
  pendingPurchases: PurchaseRow[];
  eventsUsedTotal: number;
  eventsSlotsUsed: number;
  eventsSlotsTotal: number;
  eventsSlotsRemaining: number;
  soonestActiveExpiry: string | null;
  certificatesUsed: number;
  createEventBlock: CreateEventBlockInfo | null;
}

export interface BillingDashboardData extends OrgUsageSummary {
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
  events: EventSummaryRow[];
  topups: CertificateTopupRow[];
  isSuperAdmin: boolean;
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
  purchaseId: string | null;
  maxCertificates: number;
  retentionUntil: string | null;
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
  certificatesIssuedCount?: number;
}

export interface EventDetail extends EventSummaryRow {
  certificateTypes: CertificateTypeRow[];
  certificateTypesCount: number;
  maxCertificateTypesPerEvent: number | null;
  packageLabel: string;
  purchaseStatus: PurchaseStatus | "missing";
  purchaseExpiresAt: string | null;
  isPurchaseExpired: boolean;
  certificatesIssuedCount: number;
  certificatesDownloadedCount: number;
}

export function mapPurchaseRow(
  r: Record<string, unknown>,
  nowMs = Date.now(),
): PurchaseRow {
  const rawKind = String(r.kind ?? "custom");
  const kind: PackageKind = (
    ["single", "multi", "pro", "custom"] as const
  ).includes(rawKind as PackageKind)
    ? (rawKind as PackageKind)
    : "custom";

  const rawStatus = String(r.status ?? "pending");
  const status: PurchaseStatus = (
    ["pending", "active", "rejected", "expired"] as const
  ).includes(rawStatus as PurchaseStatus)
    ? (rawStatus as PurchaseStatus)
    : "pending";

  const expiresAt = typeof r.expires_at === "string" ? r.expires_at : null;
  const effectiveStatus: PurchaseStatus =
    status === "active" && isPlanExpired(expiresAt, nowMs) ? "expired" : status;

  const eventsTotal = Math.max(1, Number(r.events_total ?? 1));
  const eventsUsed = Math.max(0, Number(r.events_used ?? 0));

  const orgRel = Array.isArray(r.organizations)
    ? (r.organizations[0] as Record<string, unknown> | undefined)
    : (r.organizations as Record<string, unknown> | undefined);

  const rawMethod = r.payment_method ? String(r.payment_method) : null;
  const paymentMethod: PaymentMethod | null =
    rawMethod &&
    ["bank", "jazzcash", "easypaisa", "pilot", "manual"].includes(rawMethod)
      ? (rawMethod as PaymentMethod)
      : null;

  return {
    id: String(r.id),
    orgId: String(r.org_id),
    orgName: typeof orgRel?.name === "string" ? orgRel.name : undefined,
    planId: typeof r.plan_id === "string" ? r.plan_id : null,
    kind,
    eventsTotal,
    eventsUsed,
    eventsRemaining: Math.max(0, eventsTotal - eventsUsed),
    certsPerEvent: Math.max(1, Number(r.certs_per_event ?? 50)),
    months: Number(r.months ?? 3),
    listPricePkr: Number(r.list_price_pkr ?? 0),
    discountPkr: Number(r.discount_pkr ?? 0),
    finalPricePkr: Number(r.final_price_pkr ?? 0),
    isPilot: Boolean(r.is_pilot),
    paymentMethod,
    transactionReference:
      typeof r.transaction_reference === "string"
        ? r.transaction_reference
        : null,
    hasScreenshot: Boolean(r.screenshot_path),
    paymentNote: typeof r.payment_note === "string" ? r.payment_note : null,
    status,
    effectiveStatus,
    startsAt: typeof r.starts_at === "string" ? r.starts_at : null,
    expiresAt,
    reviewedBy: typeof r.reviewed_by === "string" ? r.reviewed_by : null,
    reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
  };
}

export function mapTopupRow(
  r: Record<string, unknown>,
  eventTitleById: Map<string, string>,
): CertificateTopupRow {
  const evRel = Array.isArray(r.events)
    ? (r.events[0] as Record<string, unknown> | undefined)
    : (r.events as Record<string, unknown> | undefined);
  const orgRel = Array.isArray(r.organizations)
    ? (r.organizations[0] as Record<string, unknown> | undefined)
    : (r.organizations as Record<string, unknown> | undefined);

  const eventId = String(r.event_id);
  const eventTitle =
    (typeof evRel?.title === "string" ? evRel.title : null) ??
    eventTitleById.get(eventId) ??
    "Event";

  const rawMethod = r.payment_method ? String(r.payment_method) : null;
  const paymentMethod: PaymentMethod | null =
    rawMethod &&
    ["bank", "jazzcash", "easypaisa", "pilot", "manual"].includes(rawMethod)
      ? (rawMethod as PaymentMethod)
      : null;

  const rawStatus = String(r.status ?? "pending");
  const status = (
    ["pending", "approved", "rejected"] as const
  ).includes(rawStatus as "pending" | "approved" | "rejected")
    ? (rawStatus as "pending" | "approved" | "rejected")
    : "pending";

  return {
    id: String(r.id),
    orgId: String(r.org_id),
    orgName: typeof orgRel?.name === "string" ? orgRel.name : undefined,
    eventId,
    eventTitle,
    certsAdded: Number(r.certs_added ?? 0),
    certRatePkr: Number(r.cert_rate_pkr ?? 5),
    amountPkr: Number(r.amount_pkr ?? 0),
    paymentMethod,
    transactionReference:
      typeof r.transaction_reference === "string"
        ? r.transaction_reference
        : null,
    hasScreenshot: Boolean(r.screenshot_path),
    paymentNote: typeof r.payment_note === "string" ? r.payment_note : null,
    status,
    reviewedBy: typeof r.reviewed_by === "string" ? r.reviewed_by : null,
    reviewedAt: typeof r.reviewed_at === "string" ? r.reviewed_at : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
  };
}

/**
 * Loads the current organization's package purchases, slot availability,
 * expiry countdown, and overall usage strictly scoped via `getCurrentOrg()`.
 */
export const getOrgPlanAndUsage = cache(async (): Promise<OrgUsageSummary> => {
  const { user, org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const [purchasesRes, eventsCountRes, certsCountRes] = await Promise.all([
    supabase
      .from("purchases")
      .select("*")
      .eq("org_id", org.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
    supabase
      .from("attendee_certificates")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);

  const nowMs = Date.now();
  const purchases = (
    (purchasesRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapPurchaseRow(r, nowMs));

  const activeSorted = sortActiveUnexpiredPurchases(
    purchases.map((p) => ({
      id: p.id,
      orgId: p.orgId,
      planId: p.planId,
      kind: p.kind,
      eventsTotal: p.eventsTotal,
      eventsUsed: p.eventsUsed,
      certsPerEvent: p.certsPerEvent,
      months: p.months,
      status: p.status,
      isPilot: p.isPilot,
      startsAt: p.startsAt,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
    })),
    org.id,
    nowMs,
  );

  const activeIds = new Set(activeSorted.map((a) => a.id));
  const activePurchases = purchases
    .filter((p) => activeIds.has(p.id))
    .sort((a, b) => {
      const aExp = a.expiresAt ? Date.parse(a.expiresAt) : Number.MAX_SAFE_INTEGER;
      const bExp = b.expiresAt ? Date.parse(b.expiresAt) : Number.MAX_SAFE_INTEGER;
      return aExp - bExp;
    });

  const pendingPurchases = purchases.filter((p) => p.status === "pending");
  const expiredPurchases = purchases.filter(
    (p) => p.effectiveStatus === "expired",
  );

  const eventsSlotsUsed = activePurchases.reduce(
    (sum, p) => sum + p.eventsUsed,
    0,
  );
  const eventsSlotsTotal = activePurchases.reduce(
    (sum, p) => sum + p.eventsTotal,
    0,
  );
  const eventsSlotsRemaining = activePurchases.reduce(
    (sum, p) => sum + p.eventsRemaining,
    0,
  );
  const soonestActiveExpiry = activePurchases[0]?.expiresAt ?? null;

  let createEventBlock: CreateEventBlockInfo | null = null;
  if (eventsSlotsRemaining <= 0) {
    if (pendingPurchases.length > 0) {
      createEventBlock = {
        code: "PURCHASE_PENDING",
        message:
          "Your package purchase is waiting for approval. You will be able to create events as soon as it is approved.",
      };
    } else if (activePurchases.length > 0) {
      createEventBlock = {
        code: "NO_EVENT_SLOTS",
        message: `No event slots left in your active package(s) (${eventsSlotsUsed} / ${eventsSlotsTotal} events used). Buy another package in Billing to create more events.`,
      };
    } else if (expiredPurchases.length > 0) {
      createEventBlock = {
        code: "PURCHASE_EXPIRED",
        message:
          "Your package has expired — buy a package in Billing to create new events. Read access and exports remain available.",
      };
    } else {
      createEventBlock = {
        code: "NO_ACTIVE_PURCHASE",
        message: "Buy a package in Billing before creating or releasing events.",
      };
    }
  }

  return {
    org,
    user,
    purchases,
    activePurchases,
    pendingPurchases,
    eventsUsedTotal: eventsCountRes.count ?? 0,
    eventsSlotsUsed,
    eventsSlotsTotal,
    eventsSlotsRemaining,
    soonestActiveExpiry,
    certificatesUsed: certsCountRes.count ?? 0,
    createEventBlock,
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

  const certsRel = row.attendee_certificates as
    | Array<{ count?: number }>
    | { count?: number }
    | null;
  const certificatesIssuedCount =
    certsRel !== undefined && certsRel !== null
      ? Array.isArray(certsRel)
        ? Number(certsRel[0]?.count ?? 0)
        : Number(certsRel?.count ?? 0)
      : undefined;

  return {
    id: row.id as string,
    orgId: row.org_id as string,
    purchaseId: typeof row.purchase_id === "string" ? row.purchase_id : null,
    maxCertificates: Math.max(1, Number(row.max_certificates ?? 50)),
    retentionUntil:
      typeof row.retention_until === "string" ? row.retention_until : null,
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
    certificatesIssuedCount,
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
 * Lists all events belonging to the current organization (`getCurrentOrg()`).
 */
export const getOrgEvents = cache(async (): Promise<EventSummaryRow[]> => {
  const { org } = await requireDashboardAuth();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("events")
    .select("*, attendees(count), attendee_certificates(count)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data.map((row) => mapEventRow(row as Record<string, unknown>));
});

/**
 * Fetches a single event by id ONLY if it belongs to `getCurrentOrg()`.
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
  const linkedPurchase = base.purchaseId
    ? usage.purchases.find((p) => p.id === base.purchaseId)
    : undefined;

  const purchaseStatus: PurchaseStatus | "missing" = linkedPurchase
    ? linkedPurchase.effectiveStatus
    : "missing";
  const purchaseExpiresAt = linkedPurchase?.expiresAt ?? null;
  const isPurchaseExpired = purchaseStatus === "expired";

  const packageLabel = linkedPurchase
    ? linkedPurchase.isPilot
      ? "Pilot Package"
      : `${linkedPurchase.kind.toUpperCase()} Package`
    : org.packageLabel;

  return {
    ...base,
    certificateTypes,
    certificateTypesCount: certificateTypes.length,
    maxCertificateTypesPerEvent: 20,
    packageLabel,
    purchaseStatus,
    purchaseExpiresAt,
    isPurchaseExpired,
    certificatesIssuedCount: issuedRes.count ?? 0,
    certificatesDownloadedCount: downloadedRes.count ?? 0,
  };
}

export async function getBillingDashboardData(): Promise<BillingDashboardData> {
  const [usage, events, { pricingConfig, presets }] = await Promise.all([
    getOrgPlanAndUsage(),
    getOrgEvents(),
    getPricingAndPresets(),
  ]);

  const supabase = await createSupabaseServerClient();
  const [topupsRes, superAdmin] = await Promise.all([
    supabase
      .from("certificate_topups")
      .select("*, events(title)")
      .eq("org_id", usage.org.id)
      .order("created_at", { ascending: false })
      .limit(50),
    isUserInSuperAdminsTable(usage.user.id),
  ]);

  const eventTitleById = new Map(events.map((e) => [e.id, e.title]));
  const topups = (
    (topupsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((r) => mapTopupRow(r, eventTitleById));

  return {
    ...usage,
    pricingConfig,
    presets,
    events,
    topups,
    isSuperAdmin: superAdmin,
  };
}
