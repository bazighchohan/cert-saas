import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluatePurchasePlanEnforcement,
  isPlanEnforcementError,
  isPlanExpired,
  isPlanExpiringWithinDays,
  MAX_PAYMENT_PROOF_BYTES,
  PlanEnforcementError,
  validatePaymentProofBytes,
  type PurchaseSummarySnapshot,
} from "../plan-enforcement-helpers";

function makePurchase(
  overrides: Partial<PurchaseSummarySnapshot> = {},
): PurchaseSummarySnapshot {
  return {
    id: overrides.id ?? "pur-1",
    orgId: overrides.orgId ?? "org-a",
    planId: overrides.planId ?? "multi-100",
    kind: overrides.kind ?? "multi",
    eventsTotal: overrides.eventsTotal ?? 3,
    eventsUsed: overrides.eventsUsed ?? 0,
    certsPerEvent: overrides.certsPerEvent ?? 100,
    months: overrides.months ?? 3,
    status: overrides.status ?? "active",
    isPilot: overrides.isPilot ?? false,
    startsAt: overrides.startsAt ?? "2026-11-01T00:00:00Z",
    expiresAt: overrides.expiresAt ?? "2027-02-01T00:00:00Z",
    createdAt: overrides.createdAt ?? "2026-11-01T00:00:00Z",
  };
}

describe("evaluatePurchasePlanEnforcement (packages, slots, max_certificates, expiry, suspension)", () => {
  const NOW = Date.parse("2026-11-26T00:00:00Z");

  it("blocks organizations with no purchase ('buy a package'), pending purchase ('waiting for approval'), and exhausted slots ('no event slots left')", () => {
    // 1. No purchase -> NO_ACTIVE_PURCHASE ("buy a package")
    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          { orgId: "org-a", orgStatus: "active", purchases: [] },
          null,
          "create_event",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) &&
        err.code === "NO_ACTIVE_PURCHASE" &&
        /buy a package/i.test(err.message),
    );

    // 2. Pending purchase -> PURCHASE_PENDING ("waiting for approval")
    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-a",
            orgStatus: "active",
            purchases: [makePurchase({ status: "pending", expiresAt: null })],
          },
          null,
          "create_event",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) &&
        err.code === "PURCHASE_PENDING" &&
        /waiting for approval/i.test(err.message),
    );

    // 3. Exhausted slots -> NO_EVENT_SLOTS ("no event slots left")
    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-a",
            orgStatus: "active",
            purchases: [makePurchase({ eventsTotal: 3, eventsUsed: 3 })],
          },
          null,
          "create_event",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) &&
        err.code === "NO_EVENT_SLOTS" &&
        /no event slots left/i.test(err.message),
    );
  });

  it("stacks two purchases and prefers the active purchase that expires soonest", () => {
    const laterPurchase = makePurchase({
      id: "pur-later",
      certsPerEvent: 200,
      eventsTotal: 3,
      eventsUsed: 0,
      expiresAt: "2027-06-01T00:00:00Z",
    });
    const soonerPurchase = makePurchase({
      id: "pur-sooner",
      certsPerEvent: 50,
      eventsTotal: 1,
      eventsUsed: 0,
      expiresAt: "2026-12-15T00:00:00Z",
    });

    const chosen1 = evaluatePurchasePlanEnforcement(
      {
        orgId: "org-a",
        orgStatus: "active",
        purchases: [laterPurchase, soonerPurchase],
      },
      null,
      "create_event",
      NOW,
    );
    assert.equal(chosen1.purchase.id, "pur-sooner");
    assert.equal(chosen1.maxCertificates, 50);

    // Once soonerPurchase has 1/1 used, next event falls through to laterPurchase!
    const chosen2 = evaluatePurchasePlanEnforcement(
      {
        orgId: "org-a",
        orgStatus: "active",
        purchases: [laterPurchase, { ...soonerPurchase, eventsUsed: 1 }],
      },
      null,
      "create_event",
      NOW,
    );
    assert.equal(chosen2.purchase.id, "pur-later");
    assert.equal(chosen2.maxCertificates, 200);
  });

  it("enforces per-event max_certificates and cross-org purchase isolation", () => {
    const orgAPurchase = makePurchase({ id: "pur-a", orgId: "org-a" });

    // Org B cannot consume Org A's purchase
    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-b",
            orgStatus: "active",
            purchases: [orgAPurchase],
          },
          null,
          "create_event",
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) && err.code === "NO_ACTIVE_PURCHASE",
    );

    // Event with maxCertificates = 50 allows adding 2 certs at 48 used, blocks adding 3
    assert.doesNotThrow(() =>
      evaluatePurchasePlanEnforcement(
        {
          orgId: "org-a",
          orgStatus: "active",
          purchases: [orgAPurchase],
          event: {
            id: "ev-1",
            orgId: "org-a",
            purchaseId: "pur-a",
            maxCertificates: 50,
            attendeesUsed: 48,
            certificatesUsed: 48,
          },
        },
        "ev-1",
        { kind: "import", addAttendees: 2, addCertificates: 2 },
        NOW,
      ),
    );

    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-a",
            orgStatus: "active",
            purchases: [orgAPurchase],
            event: {
              id: "ev-1",
              orgId: "org-a",
              purchaseId: "pur-a",
              maxCertificates: 50,
              attendeesUsed: 48,
              certificatesUsed: 48,
            },
          },
          "ev-1",
          { kind: "import", addAttendees: 3, addCertificates: 3 },
          NOW,
        ),
      (err: unknown) =>
        isPlanEnforcementError(err) && err.code === "PLAN_LIMIT_REACHED",
    );
  });

  it("blocks writes & attendee additions when purchase expires, and blocks suspended orgs", () => {
    const expiredIso = "2026-11-25T23:59:59Z";
    assert.equal(isPlanExpired(expiredIso, NOW), true);
    assert.equal(
      isPlanExpiringWithinDays("2026-12-05T00:00:00Z", 14, NOW),
      true,
    );

    const expiredPurchase = makePurchase({
      id: "pur-exp",
      expiresAt: expiredIso,
    });

    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-a",
            orgStatus: "active",
            purchases: [expiredPurchase],
            event: {
              id: "ev-1",
              orgId: "org-a",
              purchaseId: "pur-exp",
              maxCertificates: 100,
              attendeesUsed: 10,
              certificatesUsed: 10,
            },
          },
          "ev-1",
          { kind: "attendee", addAttendees: 1, addCertificates: 1 },
          NOW,
        ),
      (err: unknown) =>
        err instanceof PlanEnforcementError && err.code === "PURCHASE_EXPIRED",
    );

    assert.throws(
      () =>
        evaluatePurchasePlanEnforcement(
          {
            orgId: "org-a",
            orgStatus: "suspended",
            purchases: [makePurchase()],
          },
          null,
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

    const spoofed = new TextEncoder().encode("<script>alert(1)</script>");
    assert.equal(validatePaymentProofBytes(spoofed, "image/png").valid, false);

    assert.equal(validatePaymentProofBytes(new Uint8Array(0)).valid, false);
    const oversized = new Uint8Array(MAX_PAYMENT_PROOF_BYTES + 1);
    oversized.set(png, 0);
    assert.equal(validatePaymentProofBytes(oversized, "image/png").valid, false);
  });
});
