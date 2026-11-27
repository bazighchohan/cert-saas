import type { PackageKind } from "@/lib/pricing";

export type PlanErrorCode =
  | "PLAN_LIMIT_REACHED"
  | "PURCHASE_EXPIRED"
  | "PURCHASE_PENDING"
  | "NO_ACTIVE_PURCHASE"
  | "NO_EVENT_SLOTS"
  | "ORG_SUSPENDED"
  | "NOT_FOUND"
  // Legacy alias kept for union compatibility in UI handlers
  | "PLAN_EXPIRED";

export class PlanEnforcementError extends Error {
  readonly code: PlanErrorCode;
  readonly httpStatus: number;

  constructor(code: PlanErrorCode, message: string, httpStatus = 403) {
    super(message);
    this.name = "PlanEnforcementError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isPlanEnforcementError(
  err: unknown,
): err is PlanEnforcementError {
  return err instanceof PlanEnforcementError;
}

export type PurchaseStatus = "pending" | "active" | "rejected" | "expired";

export interface PurchaseSummarySnapshot {
  id: string;
  orgId: string;
  planId: string | null;
  kind: PackageKind;
  eventsTotal: number;
  eventsUsed: number;
  certsPerEvent: number;
  months: number;
  status: PurchaseStatus;
  isPilot: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface EventEnforcementSnapshot {
  id: string;
  orgId: string;
  purchaseId: string | null;
  maxCertificates: number;
  attendeesUsed: number;
  certificatesUsed: number;
  certificateTypesUsed?: number;
  maxCertificateTypes?: number | null;
}

export interface OrgPurchaseEnforcementState {
  orgId: string;
  orgStatus: "active" | "suspended";
  purchases: PurchaseSummarySnapshot[];
  event?: EventEnforcementSnapshot | null;
}

export type PlanActionInput =
  | "create_event"
  | "release_event"
  | "write"
  | { kind: "certificate_type"; add?: number }
  | {
      kind: "attendee" | "certificate" | "import";
      addAttendees?: number;
      addCertificates?: number;
    };

export interface PlanAllowanceResult {
  purchase: PurchaseSummarySnapshot;
  maxCertificates: number;
}

/**
 * Returns true if `expiresAt` is non-null and <= reference timestamp.
 */
export function isPlanExpired(
  expiresAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= nowMs;
}

/**
 * Returns true if `expiresAt` is in the future and within `withinDays` days.
 */
export function isPlanExpiringWithinDays(
  expiresAt: string | null | undefined,
  withinDays = 14,
  nowMs = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts > nowMs && ts <= nowMs + withinDays * 86_400_000;
}

/**
 * Sorts active, unexpired purchases so slot consumption always prefers the
 * purchase that expires soonest (tie-broken by `createdAt` ascending).
 */
export function sortActiveUnexpiredPurchases(
  purchases: PurchaseSummarySnapshot[],
  orgId: string,
  nowMs = Date.now(),
): PurchaseSummarySnapshot[] {
  return purchases
    .filter(
      (p) =>
        p.orgId === orgId &&
        p.status === "active" &&
        !isPlanExpired(p.expiresAt, nowMs),
    )
    .sort((a, b) => {
      const aExp = a.expiresAt ? Date.parse(a.expiresAt) : Number.MAX_SAFE_INTEGER;
      const bExp = b.expiresAt ? Date.parse(b.expiresAt) : Number.MAX_SAFE_INTEGER;
      if (aExp !== bExp) return aExp - bExp;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}

/**
 * Pure, deterministic evaluator for `assertWithinPlan(orgId, eventId, action)`:
 * 1. Blocks suspended organizations (`ORG_SUSPENDED`).
 * 2. Enforces package purchases (no Free plan):
 *    - `"waiting for approval"` (`PURCHASE_PENDING`) if a purchase is pending
 *    - `"buy a package"` (`NO_ACTIVE_PURCHASE`) if none is active
 *    - `"no event slots left"` (`NO_EVENT_SLOTS`) if all active slots are used
 *    - Read-only expiry (`PURCHASE_EXPIRED`) when a purchase expires
 * 3. Enforces the event's own `max_certificates` on manual add, CSV import,
 *    and certificate-type assignment (`PLAN_LIMIT_REACHED`).
 */
export function evaluatePurchasePlanEnforcement(
  state: OrgPurchaseEnforcementState,
  eventId: string | null,
  action: PlanActionInput,
  nowMs = Date.now(),
): PlanAllowanceResult {
  const { orgId, orgStatus, purchases } = state;

  if (orgStatus !== "active") {
    throw new PlanEnforcementError(
      "ORG_SUSPENDED",
      "Your organization account is suspended. Contact support for assistance.",
      403,
    );
  }

  const orgPurchases = purchases.filter((p) => p.orgId === orgId);
  const activeUnexpired = sortActiveUnexpiredPurchases(
    orgPurchases,
    orgId,
    nowMs,
  );
  const availableSlotPurchases = activeUnexpired.filter(
    (p) => p.eventsUsed < p.eventsTotal,
  );
  const pendingPurchases = orgPurchases.filter((p) => p.status === "pending");
  const expiredPurchases = orgPurchases.filter(
    (p) =>
      p.status === "expired" ||
      (p.status === "active" && isPlanExpired(p.expiresAt, nowMs)),
  );

  // 1. Event creation check (eventId is null)
  if (action === "create_event") {
    if (availableSlotPurchases.length > 0) {
      const chosen = availableSlotPurchases[0];
      return {
        purchase: chosen,
        maxCertificates: chosen.certsPerEvent,
      };
    }

    if (pendingPurchases.length > 0) {
      throw new PlanEnforcementError(
        "PURCHASE_PENDING",
        "Your package purchase is waiting for approval. You will be able to create events as soon as it is approved.",
        402,
      );
    }

    if (activeUnexpired.length > 0) {
      const usedTotal = activeUnexpired.reduce((s, p) => s + p.eventsUsed, 0);
      const slotsTotal = activeUnexpired.reduce((s, p) => s + p.eventsTotal, 0);
      throw new PlanEnforcementError(
        "NO_EVENT_SLOTS",
        `No event slots left in your active package(s) (${usedTotal} / ${slotsTotal} events used). Buy another package in Billing to create more events.`,
        402,
      );
    }

    if (expiredPurchases.length > 0) {
      throw new PlanEnforcementError(
        "PURCHASE_EXPIRED",
        "Your package has expired — please buy a package in Billing to create new events. Read access and exports remain available.",
        402,
      );
    }

    throw new PlanEnforcementError(
      "NO_ACTIVE_PURCHASE",
      "Please buy a package in Billing before creating an event.",
      402,
    );
  }

  // 2. General org write check without a specific event
  if (action === "write" && !eventId) {
    if (activeUnexpired.length > 0) {
      return {
        purchase: activeUnexpired[0],
        maxCertificates: activeUnexpired[0].certsPerEvent,
      };
    }
    if (pendingPurchases.length > 0) {
      throw new PlanEnforcementError(
        "PURCHASE_PENDING",
        "Your package purchase is waiting for approval.",
        402,
      );
    }
    if (expiredPurchases.length > 0) {
      throw new PlanEnforcementError(
        "PURCHASE_EXPIRED",
        "Your package has expired. Your organization keeps read access and exports; buy a package in Billing to make changes.",
        402,
      );
    }
    throw new PlanEnforcementError(
      "NO_ACTIVE_PURCHASE",
      "Please buy a package in Billing to create or edit events.",
      402,
    );
  }

  // 3. Event-scoped checks: release_event, write (with eventId), certificate_type, attendee/certificate/import
  const ev = state.event;
  if (!eventId || !ev || ev.id !== eventId || ev.orgId !== orgId) {
    throw new PlanEnforcementError(
      "NOT_FOUND",
      "Event not found for your organization.",
      404,
    );
  }

  const backingPurchase = ev.purchaseId
    ? orgPurchases.find((p) => p.id === ev.purchaseId)
    : undefined;

  if (!backingPurchase) {
    if (pendingPurchases.length > 0) {
      throw new PlanEnforcementError(
        "PURCHASE_PENDING",
        "Your package purchase is waiting for approval. Every organization needs an approved purchase before creating or releasing events.",
        402,
      );
    }
    throw new PlanEnforcementError(
      "NO_ACTIVE_PURCHASE",
      "Please buy a package in Billing — every event requires an approved package.",
      402,
    );
  }

  if (backingPurchase.status === "pending") {
    throw new PlanEnforcementError(
      "PURCHASE_PENDING",
      "Your package purchase is waiting for approval.",
      402,
    );
  }

  if (backingPurchase.status === "rejected") {
    throw new PlanEnforcementError(
      "NO_ACTIVE_PURCHASE",
      "No approved package is active for this event. Please buy a package in Billing.",
      402,
    );
  }

  if (
    backingPurchase.status === "expired" ||
    isPlanExpired(backingPurchase.expiresAt, nowMs)
  ) {
    throw new PlanEnforcementError(
      "PURCHASE_EXPIRED",
      "The package for this event has expired. Your organization keeps read access and exports, while released public certificate downloads remain active until the retention date.",
      402,
    );
  }

  if (action === "release_event" || action === "write") {
    return {
      purchase: backingPurchase,
      maxCertificates: ev.maxCertificates,
    };
  }

  if (action.kind === "certificate_type") {
    const addCount = Math.max(0, action.add ?? 1);
    const maxTypes =
      ev.maxCertificateTypes === undefined ? 20 : ev.maxCertificateTypes;
    const usedTypes = ev.certificateTypesUsed ?? 0;
    if (addCount > 0 && maxTypes !== null && usedTypes + addCount > maxTypes) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `This event already has ${usedTypes} / ${maxTypes} certificate types.`,
        402,
      );
    }
    return {
      purchase: backingPurchase,
      maxCertificates: ev.maxCertificates,
    };
  }

  // attendee | certificate | import -> enforce event.maxCertificates
  const maxCerts = ev.maxCertificates;
  const addAttendees = Math.max(0, action.addAttendees ?? 0);
  const addCertificates = Math.max(0, action.addCertificates ?? 0);

  if (addCertificates > 0 && ev.certificatesUsed + addCertificates > maxCerts) {
    throw new PlanEnforcementError(
      "PLAN_LIMIT_REACHED",
      `Certificate limit reached for this event (${ev.certificatesUsed} / ${maxCerts} certificates used; tried to add ${addCertificates}). Top up certificates in Billing to raise this event's limit.`,
      402,
    );
  }

  if (addAttendees > 0 && ev.attendeesUsed + addAttendees > maxCerts) {
    throw new PlanEnforcementError(
      "PLAN_LIMIT_REACHED",
      `Certificate limit reached for this event (${ev.attendeesUsed} / ${maxCerts} attendees used; tried to add ${addAttendees}). Top up certificates in Billing to raise this event's limit.`,
      402,
    );
  }

  return {
    purchase: backingPurchase,
    maxCertificates: maxCerts,
  };
}

export const MAX_PAYMENT_PROOF_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Validates payment screenshot / receipt magic bytes & MIME type server-side.
 * Accepts PNG, JPEG, WebP, and PDF up to 5 MB.
 */
export function validatePaymentProofBytes(
  bytes: Uint8Array,
  declaredMime?: string,
):
  | {
      valid: true;
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
      extension: "png" | "jpg" | "webp" | "pdf";
    }
  | { valid: false; error: string } {
  if (bytes.byteLength === 0) {
    return { valid: false, error: "Payment screenshot file is empty." };
  }
  if (bytes.byteLength > MAX_PAYMENT_PROOF_BYTES) {
    return {
      valid: false,
      error: "Payment screenshot exceeds the 5 MB maximum size limit.",
    };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { valid: true, mimeType: "image/png", extension: "png" };
  }

  // JPEG: FF D8 FF
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { valid: true, mimeType: "image/jpeg", extension: "jpg" };
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { valid: true, mimeType: "image/webp", extension: "webp" };
  }

  // PDF: "%PDF-"
  if (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { valid: true, mimeType: "application/pdf", extension: "pdf" };
  }

  return {
    valid: false,
    error: `Unsupported file format (${declaredMime || "unknown"}). Upload a PNG, JPG, WebP, or PDF receipt screenshot.`,
  };
}
