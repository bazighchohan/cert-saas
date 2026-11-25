import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluatePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  MAX_PAYMENT_PROOF_BYTES,
  PlanEnforcementError,
  validatePaymentProofBytes,
  type PlanQuotaLimits,
} from "../plan-enforcement-helpers";

const FREE_PLAN: PlanQuotaLimits = {
  id: "free",
  name: "Free",
  maxEvents: 1,
  maxCertificatesPerEvent: 50,
  maxCertificatesTotal: 50,
  maxCertificateTypesPerEvent: 3,
};

const STARTER_PLAN: PlanQuotaLimits = {
  id: "starter",
  name: "Starter",
  maxEvents: 10,
  maxCertificatesPerEvent: 500,
  maxCertificatesTotal: 5000,
  maxCertificateTypesPerEvent: 10,
};

const PRO_PLAN: PlanQuotaLimits = {
  id: "pro",
  name: "Pro",
  maxEvents: null,
  maxCertificatesPerEvent: 5000,
  maxCertificatesTotal: null,
  maxCertificateTypesPerEvent: null,
};

describe("evaluatePlanEnforcement (quotas, read-only expiration, suspension)", () => {
  const NOW = Date.parse("2026-11-26T00:00:00Z");

  it("enforces max_events, max_certificate_types_per_event, max_certificates_per_event, and max_certificates_total", () => {
    // 1. Free plan with 0 events allows creating 1st event
    assert.doesNotThrow(() =>
      evaluatePlanEnforcement(
        {
          orgStatus: "active",
          planExpiresAt: null,
          plan: FREE_PLAN,
          eventsUsed: 0,
        },
        "event",
        NOW,
      ),
    );

    // 2. Free plan with 1 event blocks 2nd event with PLAN_LIMIT_REACHED
    assert.throws(
      () =>
        evaluatePlanEnforcement(
          {
            orgStatus: "active",
            planExpiresAt: null,
            plan: FREE_PLAN,
            eventsUsed: 1,
          },
          "event",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) && err.code === "PLAN_LIMIT_REACHED",
    );

    // 3. After upgrading to Starter (max 10 events) or Pro (unlimited), creating 2nd event succeeds
    assert.doesNotThrow(() =>
      evaluatePlanEnforcement(
        {
          orgStatus: "active",
          planExpiresAt: "2026-12-26T00:00:00Z",
          plan: STARTER_PLAN,
          eventsUsed: 1,
        },
        "event",
        NOW,
      ),
    );
    assert.doesNotThrow(() =>
      evaluatePlanEnforcement(
        {
          orgStatus: "active",
          planExpiresAt: "2026-12-26T00:00:00Z",
          plan: PRO_PLAN,
          eventsUsed: 250,
        },
        "event",
        NOW,
      ),
    );

    // 4. Certificate types per event limit
    assert.throws(
      () =>
        evaluatePlanEnforcement(
          {
            orgStatus: "active",
            planExpiresAt: null,
            plan: FREE_PLAN,
            eventTypesUsed: 3,
          },
          { kind: "certificate_type", eventId: "ev-1", add: 1 },
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) && err.code === "PLAN_LIMIT_REACHED",
    );

    // 5. Per-event certificates & total certificates across events
    assert.throws(
      () =>
        evaluatePlanEnforcement(
          {
            orgStatus: "active",
            planExpiresAt: null,
            plan: FREE_PLAN,
            eventAttendeesUsed: 49,
            eventCertificatesUsed: 49,
            totalCertificatesUsed: 49,
          },
          {
            kind: "import",
            eventId: "ev-1",
            addAttendees: 2,
            addCertificates: 2,
          },
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) && err.code === "PLAN_LIMIT_REACHED",
    );

    // Total certificates across events exceeded even when single event has room
    assert.throws(
      () =>
        evaluatePlanEnforcement(
          {
            orgStatus: "active",
            planExpiresAt: "2026-12-26T00:00:00Z",
            plan: STARTER_PLAN,
            eventAttendeesUsed: 10,
            eventCertificatesUsed: 10,
            totalCertificatesUsed: 4995,
          },
          {
            kind: "certificate",
            eventId: "ev-2",
            addCertificates: 10,
          },
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) &&
        err.code === "PLAN_LIMIT_REACHED" &&
        /across all events/i.test(err.message),
    );
  });

  it("places expired plans into read-only mode (blocks all writes/creates with PLAN_EXPIRED)", () => {
    const expiredIso = "2026-11-25T23:59:59Z"; // 1 second before NOW
    assert.equal(isPlanExpired(expiredIso, NOW), true);
    assert.equal(isPlanExpired("2026-11-26T00:00:01Z", NOW), false);
    assert.equal(isPlanExpired(null, NOW), false);

    // Expiring within 7 days helper
    assert.equal(
      isPlanExpiringWithinDays("2026-11-30T00:00:00Z", 7, NOW),
      true,
    );
    assert.equal(
      isPlanExpiringWithinDays("2026-12-15T00:00:00Z", 7, NOW),
      false,
    );
    assert.equal(isPlanExpiringWithinDays(expiredIso, 7, NOW), false);

    // Expired Starter plan with plenty of unused quota still blocks writes & creates
    for (const resource of [
      "write",
      "event",
      { kind: "attendee", eventId: "ev-1", addAttendees: 1, addCertificates: 1 },
    ] as const) {
      assert.throws(
        () =>
          evaluatePlanEnforcement(
            {
              orgStatus: "active",
              planExpiresAt: expiredIso,
              plan: STARTER_PLAN,
              eventsUsed: 0,
              eventAttendeesUsed: 0,
              eventCertificatesUsed: 0,
              totalCertificatesUsed: 0,
            },
            resource,
            NOW,
          ),
        (err: unknown) =>
          err instanceof PlanEnforcementError &&
          err.code === "PLAN_EXPIRED" &&
          err.httpStatus === 402 &&
          /read-only mode/i.test(err.message),
      );
    }

    // Suspended org blocks with ORG_SUSPENDED (403)
    assert.throws(
      () =>
        evaluatePlanEnforcement(
          {
            orgStatus: "suspended",
            planExpiresAt: null,
            plan: FREE_PLAN,
          },
          "write",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) &&
        err.code === "ORG_SUSPENDED" &&
        err.httpStatus === 403,
    );
  });
});

describe("validatePaymentProofBytes", () => {
  it("validates PNG, JPEG, WebP, and PDF magic bytes and rejects invalid or oversized receipts", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.deepEqual(validatePaymentProofBytes(png, "image/png"), {
      valid: true,
      mimeType: "image/png",
      extension: "png",
    });

    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.deepEqual(validatePaymentProofBytes(jpg, "image/jpeg"), {
      valid: true,
      mimeType: "image/jpeg",
      extension: "jpg",
    });

    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    assert.deepEqual(validatePaymentProofBytes(webp, "image/webp"), {
      valid: true,
      mimeType: "image/webp",
      extension: "webp",
    });

    const pdf = new TextEncoder().encode("%PDF-1.7 fake receipt");
    assert.deepEqual(validatePaymentProofBytes(pdf, "application/pdf"), {
      valid: true,
      mimeType: "application/pdf",
      extension: "pdf",
    });

    // Reject spoofed HTML/script disguised as image/png
    const spoofed = new TextEncoder().encode("<script>alert(1)</script>");
    const spoofRes = validatePaymentProofBytes(spoofed, "image/png");
    assert.equal(spoofRes.valid, false);

    // Reject empty and > 5 MB
    assert.equal(validatePaymentProofBytes(new Uint8Array(0)).valid, false);
    const oversized = new Uint8Array(MAX_PAYMENT_PROOF_BYTES + 1);
    oversized.set(png, 0);
    assert.equal(validatePaymentProofBytes(oversized, "image/png").valid, false);
  });
});
