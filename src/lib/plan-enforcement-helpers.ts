export type PlanErrorCode =
  | "PLAN_LIMIT_REACHED"
  | "PLAN_EXPIRED"
  | "ORG_SUSPENDED";

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

export type PlanResourceInput =
  | "write"
  | "event"
  | { kind: "write" }
  | { kind: "event"; add?: number }
  | { kind: "certificate_type"; eventId: string; add?: number }
  | {
      kind: "attendee" | "certificate" | "import";
      eventId: string;
      addAttendees?: number;
      addCertificates?: number;
    };

export interface NormalizedPlanResource {
  kind: "write" | "event" | "certificate_type" | "attendee" | "certificate" | "import";
  eventId?: string;
  addCount: number;
  addAttendees: number;
  addCertificates: number;
}

export interface PlanQuotaLimits {
  id: string;
  name: string;
  maxEvents: number | null;
  maxCertificatesPerEvent: number | null;
  maxCertificatesTotal: number | null;
  maxCertificateTypesPerEvent: number | null;
}

export interface OrgPlanStateSnapshot {
  orgStatus: "active" | "suspended";
  planExpiresAt: string | null;
  plan: PlanQuotaLimits;
  eventsUsed?: number;
  eventTypesUsed?: number;
  eventAttendeesUsed?: number;
  eventCertificatesUsed?: number;
  totalCertificatesUsed?: number;
}

export function normalizePlanResource(
  resource: PlanResourceInput,
): NormalizedPlanResource {
  if (resource === "write") {
    return {
      kind: "write",
      addCount: 0,
      addAttendees: 0,
      addCertificates: 0,
    };
  }
  if (resource === "event") {
    return {
      kind: "event",
      addCount: 1,
      addAttendees: 0,
      addCertificates: 0,
    };
  }
  if (resource.kind === "write") {
    return {
      kind: "write",
      addCount: 0,
      addAttendees: 0,
      addCertificates: 0,
    };
  }
  if (resource.kind === "event") {
    return {
      kind: "event",
      addCount: Math.max(0, resource.add ?? 1),
      addAttendees: 0,
      addCertificates: 0,
    };
  }
  if (resource.kind === "certificate_type") {
    return {
      kind: "certificate_type",
      eventId: resource.eventId,
      addCount: Math.max(0, resource.add ?? 1),
      addAttendees: 0,
      addCertificates: 0,
    };
  }

  return {
    kind: resource.kind,
    eventId: resource.eventId,
    addCount: 0,
    addAttendees: Math.max(0, resource.addAttendees ?? 0),
    addCertificates: Math.max(0, resource.addCertificates ?? 0),
  };
}

/**
 * Returns true if `planExpiresAt` is non-null and <= reference timestamp.
 */
export function isPlanExpired(
  planExpiresAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!planExpiresAt) return false;
  const ts = Date.parse(planExpiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= nowMs;
}

/**
 * Returns true if `planExpiresAt` is in the future and within `withinDays` days.
 */
export function isPlanExpiringWithinDays(
  planExpiresAt: string | null | undefined,
  withinDays = 7,
  nowMs = Date.now(),
): boolean {
  if (!planExpiresAt) return false;
  const ts = Date.parse(planExpiresAt);
  if (Number.isNaN(ts)) return false;
  return ts > nowMs && ts <= nowMs + withinDays * 86_400_000;
}

/**
 * Pure, deterministic evaluation of organization status, plan expiration (read-only mode),
 * and resource quotas. Throws `PlanEnforcementError` when blocked.
 */
export function evaluatePlanEnforcement(
  snapshot: OrgPlanStateSnapshot,
  rawResource: PlanResourceInput,
  nowMs = Date.now(),
): void {
  const resource = normalizePlanResource(rawResource);
  const { orgStatus, planExpiresAt, plan } = snapshot;

  // 1. Suspended organization check
  if (orgStatus !== "active") {
    throw new PlanEnforcementError(
      "ORG_SUSPENDED",
      "Your organization account is suspended. Contact support for assistance.",
      403,
    );
  }

  // 2. Expired plan -> Read-Only Mode check
  //    Admins can view and export data, and public downloads keep working,
  //    but creating or mutating resources in the dashboard is blocked.
  if (isPlanExpired(planExpiresAt, nowMs)) {
    const formattedDate = new Date(planExpiresAt!).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    throw new PlanEnforcementError(
      "PLAN_EXPIRED",
      `Your ${plan.name} plan expired on ${formattedDate}. Your organization is in read-only mode (viewing and exports remain available, and public certificate downloads stay live). Renew or upgrade in Billing to create or edit resources.`,
      402,
    );
  }

  // 3. Resource-specific plan limit checks
  if (resource.kind === "write") {
    return;
  }

  if (resource.kind === "event") {
    const used = snapshot.eventsUsed ?? 0;
    if (
      resource.addCount > 0 &&
      plan.maxEvents !== null &&
      used + resource.addCount > plan.maxEvents
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Your organization has reached the ${plan.name} plan limit of ${plan.maxEvents} event${
          plan.maxEvents === 1 ? "" : "s"
        } (${used}/${plan.maxEvents} used). Request an upgrade in Billing to create more events.`,
        402,
      );
    }
    return;
  }

  if (resource.kind === "certificate_type") {
    const used = snapshot.eventTypesUsed ?? 0;
    if (
      resource.addCount > 0 &&
      plan.maxCertificateTypesPerEvent !== null &&
      used + resource.addCount > plan.maxCertificateTypesPerEvent
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Your ${plan.name} plan allows up to ${plan.maxCertificateTypesPerEvent} certificate type${
          plan.maxCertificateTypesPerEvent === 1 ? "" : "s"
        } per event (${used}/${plan.maxCertificateTypesPerEvent} used). Request an upgrade in Billing to add more certificate types.`,
        402,
      );
    }
    return;
  }

  // attendee | certificate | import
  const eventAttendeesUsed = snapshot.eventAttendeesUsed ?? 0;
  const eventCertsUsed = snapshot.eventCertificatesUsed ?? 0;
  const totalCertsUsed = snapshot.totalCertificatesUsed ?? 0;

  if (resource.addCertificates > 0) {
    if (
      plan.maxCertificatesPerEvent !== null &&
      eventCertsUsed + resource.addCertificates > plan.maxCertificatesPerEvent
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Plan limit reached: issuing ${resource.addCertificates} more certificate${
          resource.addCertificates === 1 ? "" : "s"
        } would exceed the ${plan.name} plan limit of ${plan.maxCertificatesPerEvent} certificates per event (${eventCertsUsed}/${plan.maxCertificatesPerEvent} used). Upgrade your plan in Billing.`,
        402,
      );
    }

    if (
      plan.maxCertificatesTotal !== null &&
      totalCertsUsed + resource.addCertificates > plan.maxCertificatesTotal
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Plan limit reached: issuing ${resource.addCertificates} more certificate${
          resource.addCertificates === 1 ? "" : "s"
        } would exceed the ${plan.name} plan total limit of ${plan.maxCertificatesTotal} certificates across all events (${totalCertsUsed}/${plan.maxCertificatesTotal} used). Upgrade your plan in Billing.`,
        402,
      );
    }
  }

  if (resource.addAttendees > 0) {
    if (
      plan.maxCertificatesPerEvent !== null &&
      eventAttendeesUsed + resource.addAttendees > plan.maxCertificatesPerEvent
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Plan limit reached: adding ${resource.addAttendees} attendee${
          resource.addAttendees === 1 ? "" : "s"
        } would exceed the ${plan.name} plan limit of ${plan.maxCertificatesPerEvent} attendees per event (${eventAttendeesUsed}/${plan.maxCertificatesPerEvent} used). Upgrade your plan in Billing.`,
        402,
      );
    }

    if (
      resource.addCertificates === 0 &&
      plan.maxCertificatesTotal !== null &&
      totalCertsUsed + resource.addAttendees > plan.maxCertificatesTotal
    ) {
      throw new PlanEnforcementError(
        "PLAN_LIMIT_REACHED",
        `Plan limit reached: your organization has already used ${totalCertsUsed}/${plan.maxCertificatesTotal} total certificates on the ${plan.name} plan. Upgrade your plan in Billing.`,
        402,
      );
    }
  }
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
