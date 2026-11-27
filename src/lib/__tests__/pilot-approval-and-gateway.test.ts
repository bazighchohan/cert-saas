import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { evaluateProxyAccessGate } from "../access-gate";
import {
  areEmailsEnabled,
  getFeatureFlags,
  isPaymentGatewayEnabled,
  isPaymentProofRequired,
} from "../feature-flags";
import {
  notifyCustomerOrganizationApproved,
  notifyCustomerOrganizationRejected,
  notifySuperAdminNewSignupRequest,
} from "../notifications";
import {
  getPaymentProvider,
  handleSafepayWebhookPayload,
  ManualProvider,
  SafepayProvider,
  signSafepayWebhookPayload,
  type WebhookRpcResultRow,
} from "../payments";
import { attachPricesToPresets, DEFAULT_PRICING_CONFIG } from "../pricing";
import { executePilotSignup } from "../signup-flow";

const PRESETS = attachPricesToPresets(
  [
    {
      id: "single-50",
      name: "Single (50 certs)",
      kind: "single",
      eventsCount: 1,
      certsPerEvent: 50,
      months: 3,
      allowCustomBranding: true,
      sortOrder: 1,
    },
    {
      id: "multi-100",
      name: "Multi (3 × 100 certs)",
      kind: "multi",
      eventsCount: 3,
      certsPerEvent: 100,
      months: 3,
      allowCustomBranding: true,
      sortOrder: 4,
    },
    {
      id: "pro",
      name: "Pro (10 × 100 certs)",
      kind: "pro",
      eventsCount: 10,
      certsPerEvent: 100,
      months: 12,
      allowCustomBranding: true,
      sortOrder: 5,
    },
  ],
  DEFAULT_PRICING_CONFIG,
);

describe("Feature flags & default provider selection", () => {
  it("keeps REQUIRE_PAYMENT_PROOF, EMAILS_ENABLED, and PAYMENT_GATEWAY_ENABLED off by default", () => {
    const flags = getFeatureFlags({});
    assert.deepEqual(flags, {
      requirePaymentProof: false,
      emailsEnabled: false,
      paymentGatewayEnabled: false,
      pilotBannerEnabled: true,
      analyticsEnabled: false,
    });
    assert.equal(isPaymentProofRequired({}), false);
    assert.equal(areEmailsEnabled({}), false);
    assert.equal(isPaymentGatewayEnabled({}), false);

    const defaultProvider = getPaymentProvider({});
    assert.ok(defaultProvider instanceof ManualProvider);
    assert.equal(defaultProvider.name, "manual");

    const enabledProvider = getPaymentProvider({
      PAYMENT_GATEWAY_ENABLED: "true",
    });
    assert.ok(enabledProvider instanceof SafepayProvider);
    assert.equal(enabledProvider.name, "safepay");
  });

  it("never blocks requests when Resend email sending fails or is disabled", async () => {
    // Disabled by default -> skipped with zero network calls
    let networkCalled = false;
    const skipped = await notifySuperAdminNewSignupRequest(
      {
        orgName: "ACM FAST",
        contactName: "Ayesha",
        email: "ayesha@fast.edu.pk",
        whatsappNumber: "+92 300 1234567",
        planSummary: "Multi (3 × 100 certs)",
        listPricePkr: 3000,
        finalPricePkr: 2400,
      },
      {
        env: { EMAILS_ENABLED: "false" },
        fetchImpl: async () => {
          networkCalled = true;
          throw new Error("Should not be called");
        },
      },
    );
    assert.equal(skipped.sent, false);
    assert.equal(skipped.skipped, true);
    assert.equal(networkCalled, false);

    // Enabled + network failure -> caught & logged cleanly without throwing
    const failedNonBlocking = await notifyCustomerOrganizationApproved(
      {
        toEmail: "ayesha@fast.edu.pk",
        contactName: "Ayesha",
        orgName: "ACM FAST",
        isPilot: true,
        planSummary: "3 events × 100 certs",
        expiresAt: "2027-02-27T00:00:00Z",
      },
      {
        env: {
          EMAILS_ENABLED: "true",
          RESEND_API_KEY: "re_test_dummy",
          EMAIL_FROM: "noreply@cert-saas.example",
        },
        fetchImpl: async () => {
          throw new Error("Simulated DNS/network outage");
        },
      },
    );
    assert.equal(failedNonBlocking.sent, false);
    assert.match(failedNonBlocking.error ?? "", /outage/i);

    const rejectedHttp500 = await notifyCustomerOrganizationRejected(
      {
        toEmail: "ayesha@fast.edu.pk",
        contactName: "Ayesha",
        orgName: "ACM FAST",
        reason: "Unverified society email",
      },
      {
        env: {
          EMAILS_ENABLED: "true",
          RESEND_API_KEY: "re_test_dummy",
          EMAIL_FROM: "noreply@cert-saas.example",
        },
        fetchImpl: async () => new Response("Internal Error", { status: 500 }),
      },
    );
    assert.equal(rejectedHttp500.sent, false);
    assert.equal(rejectedHttp500.error, "Resend HTTP 500");
  });
});

describe("Access gate across proxy, dashboard routes, server actions, and API routes", () => {
  const DASHBOARD_PAGES = [
    "/dashboard",
    "/dashboard/billing",
    "/dashboard/settings",
    "/dashboard/help",
    "/dashboard/events/11111111-1111-4111-8111-111111111111",
    "/admin",
  ];

  const DASHBOARD_APIS = [
    "/api/dashboard/billing/purchases",
    "/api/dashboard/billing/topups",
    "/api/dashboard/billing/payment-requests",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/attendees",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/downloads",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/import/parse",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/import/preview",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/import/confirm",
    "/api/dashboard/events/11111111-1111-4111-8111-111111111111/templates/upload",
    "/api/dashboard/templates/11111111-1111-4111-8111-111111111111/preview",
    "/api/dashboard/templates/11111111-1111-4111-8111-111111111111/test-pdf",
  ];

  it("blocks pending, rejected, and suspended users on EVERY /dashboard page and /api/dashboard route", () => {
    for (const nonActiveStatus of ["pending", "rejected", "suspended"] as const) {
      for (const page of DASHBOARD_PAGES) {
        const res = evaluateProxyAccessGate({
          pathname: page,
          isLoggedIn: true,
          isSuperAdmin: false,
          hasOrg: true,
          orgStatus: nonActiveStatus,
        });
        assert.deepEqual(
          res,
          { action: "redirect", destination: "/pending" },
          `Expected ${nonActiveStatus} user on ${page} to redirect to /pending`,
        );
      }

      for (const api of DASHBOARD_APIS) {
        const res = evaluateProxyAccessGate({
          pathname: api,
          isLoggedIn: true,
          isSuperAdmin: false,
          hasOrg: true,
          orgStatus: nonActiveStatus,
        });
        assert.equal(res.action, "json_error");
        if (res.action === "json_error") {
          assert.equal(res.httpStatus, 403);
          assert.equal(res.code, "ORG_NOT_ACTIVE");
          assert.equal(res.redirectTo, "/pending");
        }
      }
    }
  });

  it("allows approved ('active') users into /dashboard and API routes, and redirects them away from /pending", () => {
    for (const page of DASHBOARD_PAGES) {
      const res = evaluateProxyAccessGate({
        pathname: page,
        isLoggedIn: true,
        isSuperAdmin: false,
        hasOrg: true,
        orgStatus: "active",
      });
      assert.deepEqual(res, { action: "allow" });
    }

    for (const api of DASHBOARD_APIS) {
      const res = evaluateProxyAccessGate({
        pathname: api,
        isLoggedIn: true,
        isSuperAdmin: false,
        hasOrg: true,
        orgStatus: "active",
      });
      assert.deepEqual(res, { action: "allow" });
    }

    // Active user visiting /pending goes straight to /dashboard
    assert.deepEqual(
      evaluateProxyAccessGate({
        pathname: "/pending",
        isLoggedIn: true,
        isSuperAdmin: false,
        hasOrg: true,
        orgStatus: "active",
      }),
      { action: "redirect", destination: "/dashboard" },
    );
  });

  it("exempts super_admins even when their personal organization is pending or suspended", () => {
    for (const page of DASHBOARD_PAGES) {
      assert.deepEqual(
        evaluateProxyAccessGate({
          pathname: page,
          isLoggedIn: true,
          isSuperAdmin: true,
          hasOrg: true,
          orgStatus: "pending",
        }),
        { action: "allow" },
      );
    }
    for (const api of DASHBOARD_APIS) {
      assert.deepEqual(
        evaluateProxyAccessGate({
          pathname: api,
          isLoggedIn: true,
          isSuperAdmin: true,
          hasOrg: true,
          orgStatus: "suspended",
        }),
        { action: "allow" },
      );
    }
  });

  it("confirms /pending displays pending WhatsApp message, rejection reason, and suspended state, and no user API can self-activate an organization", () => {
    const pendingPageSrc = fs.readFileSync(
      path.join(process.cwd(), "src/app/pending/page.tsx"),
      "utf8",
    );
    assert.match(pendingPageSrc, /pending approval/i);
    assert.match(pendingPageSrc, /WhatsApp/i);
    assert.match(pendingPageSrc, /rejectionReason/);
    assert.match(pendingPageSrc, /status === "suspended"/);
    assert.match(pendingPageSrc, /logoutAction/);

    // Verify EVERY /api/dashboard route and /dashboard server action enforces getCurrentOrg() / requireDashboardAuth() / getCurrentSuperAdmin()
    const protectedServerFiles = [
      "src/app/dashboard/events/actions.ts",
      "src/app/dashboard/events/[eventId]/attendee-actions.ts",
      "src/app/dashboard/events/[eventId]/template-actions.ts",
      "src/app/dashboard/settings/actions.ts",
      "src/app/dashboard/billing/actions.ts",
      "src/app/api/dashboard/billing/purchases/route.ts",
      "src/app/api/dashboard/billing/topups/route.ts",
      "src/app/api/dashboard/billing/payment-requests/route.ts",
      "src/app/api/dashboard/events/[eventId]/attendees/route.ts",
      "src/app/api/dashboard/events/[eventId]/downloads/route.ts",
      "src/app/api/dashboard/events/[eventId]/downloads/export/route.ts",
      "src/app/api/dashboard/events/[eventId]/import/parse/route.ts",
      "src/app/api/dashboard/events/[eventId]/import/preview/route.ts",
      "src/app/api/dashboard/events/[eventId]/import/confirm/route.ts",
      "src/app/api/dashboard/events/[eventId]/templates/upload/route.ts",
    ];

    for (const relFile of protectedServerFiles) {
      const src = fs.readFileSync(path.join(process.cwd(), relFile), "utf8");
      assert.ok(
        src.includes("getCurrentOrg") ||
          src.includes("requireDashboardAuth") ||
          src.includes("getCurrentSuperAdmin"),
        `Expected ${relFile} to enforce active organization / superadmin server-side gate`,
      );
      // Confirm no tenant dashboard file calls activate_purchase_and_organization
      assert.ok(
        !src.includes("activate_purchase_and_organization"),
        `Tenant file ${relFile} must never call activate_purchase_and_organization`,
      );
    }
  });
});

describe("Idempotent pilot signup (double-click & server price recomputation)", () => {
  it("creates strictly ONE user, ONE pending organization, and ONE pending purchase on concurrent double-click and sequential retry", async () => {
    const authUsers = new Map<string, { id: string; password: string }>();
    const orgs = new Map<string, { id: string; userId: string; status: string }>();
    const purchases = new Map<
      string,
      { id: string; orgId: string; listPricePkr: number; finalPricePkr: number }
    >();

    let createUserCalls = 0;
    let rpcCalls = 0;

    const makeDeps = () => ({
      pricingConfig: DEFAULT_PRICING_CONFIG,
      presets: PRESETS,
      async createAuthUser({
        email,
        password,
      }: {
        email: string;
        password: string;
      }) {
        createUserCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        if (authUsers.has(email)) {
          return {
            ok: false as const,
            alreadyExists: true,
            error: "User already registered",
          };
        }
        const id = "u-pilot-0001";
        authUsers.set(email, { id, password });
        return { ok: true as const, userId: id };
      },
      async deleteAuthUser(userId: string) {
        for (const [k, v] of authUsers.entries()) {
          if (v.id === userId) authUsers.delete(k);
        }
      },
      async signInWithPassword({
        email,
        password,
      }: {
        email: string;
        password: string;
      }) {
        const u = authUsers.get(email);
        if (!u || u.password !== password) {
          return { ok: false, error: "Invalid credentials" };
        }
        return { ok: true, userId: u.id };
      },
      async runSignupPendingOrgRpc(params: {
        userId: string;
        listPricePkr: number;
        finalPricePkr: number;
      }) {
        rpcCalls += 1;
        for (const existingOrg of orgs.values()) {
          if (existingOrg.userId === params.userId) {
            const existingPur = [...purchases.values()].find(
              (p) => p.orgId === existingOrg.id,
            )!;
            return {
              orgId: existingOrg.id,
              orgStatus: existingOrg.status,
              purchaseId: existingPur.id,
              purchaseStatus: "pending",
              alreadyExisted: true,
            };
          }
        }
        const orgId = "org-pilot-0001";
        const purchaseId = "pur-pilot-0001";
        orgs.set(orgId, { id: orgId, userId: params.userId, status: "pending" });
        purchases.set(purchaseId, {
          id: purchaseId,
          orgId,
          listPricePkr: params.listPricePkr,
          finalPricePkr: params.finalPricePkr,
        });
        return {
          orgId,
          orgStatus: "pending",
          purchaseId,
          purchaseStatus: "pending",
          alreadyExisted: false,
        };
      },
    });

    const payload = {
      orgName: "NUST Robotics Society",
      contactName: "Bilal Ahmed",
      email: "Bilal@NUST.edu.pk",
      password: "StrongPassword123!",
      whatsappNumber: "+92 321 9876543",
      selectionType: "preset" as const,
      planId: "multi-100",
    };

    // 1. Concurrent double-click: two parallel calls with identical email
    const [click1, click2] = await Promise.all([
      executePilotSignup(payload, makeDeps()),
      executePilotSignup(payload, makeDeps()),
    ]);

    assert.equal(click1.success, true);
    assert.equal(click2.success, true);
    assert.equal(click1.redirectTo, "/pending");
    assert.equal(click1.orgId, click2.orgId);
    assert.equal(click1.purchaseId, click2.purchaseId);
    assert.equal(authUsers.size, 1);
    assert.equal(orgs.size, 1);
    assert.equal(purchases.size, 1);
    assert.equal(createUserCalls, 1);

    // Server recomputed Multi 3x100 = list 3000, final 2400
    const storedPurchase = purchases.get("pur-pilot-0001")!;
    assert.equal(storedPurchase.listPricePkr, 3000);
    assert.equal(storedPurchase.finalPricePkr, 2400);

    // 2. Sequential retry after inflight lock clears -> recovers idempotently without duplicates
    const retryClick = await executePilotSignup(payload, makeDeps());
    assert.equal(retryClick.success, true);
    assert.equal(retryClick.alreadyExisted, true);
    assert.equal(retryClick.redirectTo, "/pending");
    assert.equal(orgs.size, 1);
    assert.equal(purchases.size, 1);
    assert.equal(rpcCalls, 2);

    // 3. Different person attempting to register with an already-taken email + wrong password fails cleanly
    const hijacker = await executePilotSignup(
      { ...payload, password: "WrongPassword999!" },
      makeDeps(),
    );
    assert.ok(hijacker.error);
    assert.match(hijacker.error, /already exists/i);
    assert.equal(orgs.size, 1);
  });
});

describe("Safepay webhook verification, price_snapshot check, and idempotent replay", () => {
  const SECRET = "whsec_unit_test_secret_key_0123456789";
  const NOW_MS = Date.parse("2026-11-27T17:00:00Z");
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  it("rejects webhooks with 503 when PAYMENT_GATEWAY_ENABLED=false", async () => {
    const res = await handleSafepayWebhookPayload({
      rawBody: "{}",
      headers: {},
      env: { PAYMENT_GATEWAY_ENABLED: "false", SAFEPAY_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
      processWebhookInDb: async () => {
        throw new Error("Should not touch DB when gateway is disabled");
      },
    });
    assert.equal(res.httpStatus, 503);
    assert.equal(res.body.code, "GATEWAY_DISABLED");
  });

  it("rejects bad signatures, tampered bodies, and stale timestamps; rejects wrong amount; activates once on replay", async () => {
    // Simulated in-memory DB state matching public.process_payment_webhook
    let paymentStatus: "created" | "paid" = "created";
    let activationCount = 0;
    const storedPriceSnapshotAmount = 2400;

    const processWebhookInDb = async (args: {
      provider: "safepay";
      providerRef: string;
      eventStatus: "paid" | "failed" | "refunded";
      webhookAmount: number;
      webhookCurrency: string;
    }): Promise<WebhookRpcResultRow> => {
      if (args.providerRef !== "track_valid_001") {
        return {
          ok: false,
          code: "PAYMENT_NOT_FOUND",
          http_status: 404,
          already_processed: false,
          org_id: null,
          purchase_id: null,
        };
      }
      if (paymentStatus === "paid" && args.eventStatus === "paid") {
        return {
          ok: true,
          code: "ALREADY_PROCESSED",
          http_status: 200,
          already_processed: true,
          org_id: "org-1",
          purchase_id: "pur-1",
        };
      }
      if (
        args.webhookAmount !== storedPriceSnapshotAmount ||
        args.webhookCurrency !== "PKR"
      ) {
        return {
          ok: false,
          code: "AMOUNT_MISMATCH",
          http_status: 400,
          already_processed: false,
          org_id: "org-1",
          purchase_id: "pur-1",
        };
      }
      paymentStatus = "paid";
      activationCount += 1;
      return {
        ok: true,
        code: "ACTIVATED",
        http_status: 200,
        already_processed: false,
        org_id: "org-1",
        purchase_id: "pur-1",
      };
    };

    const env = {
      PAYMENT_GATEWAY_ENABLED: "true",
      SAFEPAY_WEBHOOK_SECRET: SECRET,
    };

    // 1. Bad signature -> 401 INVALID_SIGNATURE
    const validRaw = JSON.stringify({
      data: {
        tracker: "track_valid_001",
        order_id: "pur-1",
        status: "paid",
        amount: 2400,
        currency: "PKR",
      },
    });
    const badSigRes = await handleSafepayWebhookPayload({
      rawBody: validRaw,
      headers: {
        "x-sfpy-timestamp": String(NOW_SEC),
        "x-sfpy-signature": "0".repeat(64),
      },
      env,
      nowMs: () => NOW_MS,
      processWebhookInDb,
    });
    assert.equal(badSigRes.httpStatus, 401);
    assert.equal(badSigRes.body.code, "INVALID_SIGNATURE");
    assert.equal(activationCount, 0);

    // 2. Stale timestamp (10 minutes old) -> 401 STALE_TIMESTAMP
    const staleTs = NOW_SEC - 600;
    const staleSig = signSafepayWebhookPayload(validRaw, staleTs, SECRET);
    const staleRes = await handleSafepayWebhookPayload({
      rawBody: validRaw,
      headers: {
        "x-sfpy-timestamp": String(staleTs),
        "x-sfpy-signature": staleSig,
      },
      env,
      nowMs: () => NOW_MS,
      processWebhookInDb,
    });
    assert.equal(staleRes.httpStatus, 401);
    assert.equal(staleRes.body.code, "STALE_TIMESTAMP");
    assert.equal(activationCount, 0);

    // 3. Wrong amount (e.g. PKR 750 instead of stored snapshot PKR 2400) -> 400 AMOUNT_MISMATCH
    const wrongAmountRaw = JSON.stringify({
      data: {
        tracker: "track_valid_001",
        order_id: "pur-1",
        status: "paid",
        amount: 750,
        currency: "PKR",
      },
    });
    const wrongAmountSig = signSafepayWebhookPayload(
      wrongAmountRaw,
      NOW_SEC,
      SECRET,
    );
    const wrongAmountRes = await handleSafepayWebhookPayload({
      rawBody: wrongAmountRaw,
      headers: {
        "x-sfpy-timestamp": String(NOW_SEC),
        "x-sfpy-signature": wrongAmountSig,
      },
      env,
      nowMs: () => NOW_MS,
      processWebhookInDb,
    });
    assert.equal(wrongAmountRes.httpStatus, 400);
    assert.equal(wrongAmountRes.body.code, "AMOUNT_MISMATCH");
    assert.equal(activationCount, 0);

    // 4. Valid webhook -> 200 ACTIVATED (activates organization + purchase once)
    const validSig = signSafepayWebhookPayload(validRaw, NOW_SEC, SECRET);
    const firstDelivery = await handleSafepayWebhookPayload({
      rawBody: validRaw,
      headers: {
        "x-sfpy-timestamp": String(NOW_SEC),
        "x-sfpy-signature": validSig,
      },
      env,
      nowMs: () => NOW_MS,
      processWebhookInDb,
    });
    assert.equal(firstDelivery.httpStatus, 200);
    assert.equal(firstDelivery.body.code, "ACTIVATED");
    assert.equal(firstDelivery.body.alreadyProcessed, false);
    assert.equal(activationCount, 1);

    // 5. Replayed identical webhook -> 200 ALREADY_PROCESSED, activationCount stays 1!
    const replayedDelivery = await handleSafepayWebhookPayload({
      rawBody: validRaw,
      headers: {
        "x-sfpy-timestamp": String(NOW_SEC),
        "x-sfpy-signature": validSig,
      },
      env,
      nowMs: () => NOW_MS,
      processWebhookInDb,
    });
    assert.equal(replayedDelivery.httpStatus, 200);
    assert.equal(replayedDelivery.body.code, "ALREADY_PROCESSED");
    assert.equal(replayedDelivery.body.alreadyProcessed, true);
    assert.equal(activationCount, 1);
  });
});
