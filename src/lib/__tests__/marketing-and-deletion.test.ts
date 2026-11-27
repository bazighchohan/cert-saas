import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import robots from "../../app/robots";
import sitemap from "../../app/sitemap";
import { HELP_GUIDES } from "../../components/marketing/HelpGuidesContent";
import {
  executeEventDataPurge,
  executeOrganizationDeletion,
  filterSafeOrgPaths,
} from "../data-deletion";
import { validateEventSlug } from "../event-validation";
import {
  getCookieFreeAnalyticsConfig,
  isAnalyticsEnabled,
  isPilotBannerEnabled,
} from "../feature-flags";
import {
  buildSignupHrefForPlan,
  parsePlanSelectionFromParams,
  signPlanSelectionCookie,
  verifyPlanSelectionCookie,
} from "../plan-selection-cookie";
import {
  attachPricesToPresets,
  computePrice,
  DEFAULT_PRICING_CONFIG,
} from "../pricing";
import {
  findSampleCertificateByVerifyCode,
  SAMPLE_ATTENDEES,
  SAMPLE_EVENT_SLUG,
} from "../sample-event";

const BASE_PRESETS = [
  {
    id: "single-50",
    name: "Single (50 certs)",
    kind: "single" as const,
    eventsCount: 1,
    certsPerEvent: 50,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 1,
  },
  {
    id: "single-100",
    name: "Single (100 certs)",
    kind: "single" as const,
    eventsCount: 1,
    certsPerEvent: 100,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 2,
  },
  {
    id: "multi-50",
    name: "Multi (3 × 50 certs)",
    kind: "multi" as const,
    eventsCount: 3,
    certsPerEvent: 50,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 3,
  },
  {
    id: "multi-100",
    name: "Multi (3 × 100 certs)",
    kind: "multi" as const,
    eventsCount: 3,
    certsPerEvent: 100,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 4,
  },
  {
    id: "pro",
    name: "Pro (10 × 100 certs)",
    kind: "pro" as const,
    eventsCount: 10,
    certsPerEvent: 100,
    months: 12,
    allowCustomBranding: true,
    sortOrder: 5,
  },
];

describe("Plan selection flow (query params, HMAC cookie, and live pricing_config updates)", () => {
  const SECRET = "test-plan-selection-hmac-secret-123456";
  const PRICED_PRESETS = attachPricesToPresets(
    BASE_PRESETS,
    DEFAULT_PRICING_CONFIG,
  );

  it("round-trips preset and custom Build Your Own selections via query params and HMAC-signed cookie", () => {
    const multiChoice = parsePlanSelectionFromParams(
      { plan: "multi-100" },
      DEFAULT_PRICING_CONFIG,
      PRICED_PRESETS,
    );
    assert.deepEqual(multiChoice, {
      selectionType: "preset",
      planId: "multi-100",
      events: 3,
      certsPerEvent: 100,
      months: 3,
    });

    const customChoice = parsePlanSelectionFromParams(
      { plan: "custom", events: "6", certs: "175", months: "6" },
      DEFAULT_PRICING_CONFIG,
      PRICED_PRESETS,
    );
    assert.deepEqual(customChoice, {
      selectionType: "custom",
      planId: "single-50",
      events: 6,
      certsPerEvent: 175,
      months: 6,
    });

    const href = buildSignupHrefForPlan({
      selectionType: "custom",
      planId: "custom",
      events: 6,
      certsPerEvent: 175,
      months: 6,
    });
    assert.equal(
      href,
      "/api/public/select-plan?plan=custom&events=6&certs=175&months=6",
    );

    const nowMs = Date.parse("2026-11-27T18:00:00Z");
    const signedCookie = signPlanSelectionCookie(customChoice!, SECRET, nowMs);
    const verified = verifyPlanSelectionCookie(
      signedCookie,
      SECRET,
      DEFAULT_PRICING_CONFIG,
      PRICED_PRESETS,
      nowMs + 60_000,
    );
    assert.deepEqual(verified, customChoice);

    // Tampered signature rejected
    const tampered = `${signedCookie.slice(0, -4)}ffff`;
    assert.equal(
      verifyPlanSelectionCookie(
        tampered,
        SECRET,
        DEFAULT_PRICING_CONFIG,
        PRICED_PRESETS,
        nowMs,
      ),
      null,
    );

    // Expired cookie (> 7 days) rejected
    assert.equal(
      verifyPlanSelectionCookie(
        signedCookie,
        SECRET,
        DEFAULT_PRICING_CONFIG,
        PRICED_PRESETS,
        nowMs + 8 * 86_400_000,
      ),
      null,
    );
  });

  it("updates every preset and custom price immediately when pricing_config changes without code changes", () => {
    const updatedConfig = {
      ...DEFAULT_PRICING_CONFIG,
      eventFeePkr: 800,
      certRatePkr: 10,
    };
    const updatedPresets = attachPricesToPresets(BASE_PRESETS, updatedConfig);
    const single100 = updatedPresets.find((p) => p.id === "single-100")!;
    // 1 * (800 + 10*100) = 1800
    assert.equal(single100.pricing.totalPkr, 1800);

    const customCalc = computePrice(
      { events: 4, certsPerEvent: 100, months: 3 },
      updatedConfig,
    );
    // 4 * 1800 * (1 - 0.35) = 4680 -> rounded to 50 = 4700
    assert.equal(customCalc.totalPkr, 4700);
  });
});

describe("Sample event demo, public pages, help guides, SEO routes, and flags", () => {
  it("serves interactive sample event credentials and QR verification codes and reserves sample-event slug", () => {
    assert.equal(validateEventSlug(SAMPLE_EVENT_SLUG).valid, false);
    assert.equal(SAMPLE_ATTENDEES.length, 2);

    const verified = findSampleCertificateByVerifyCode("democert2026");
    assert.ok(verified);
    assert.equal(verified.recipientName, "Ayesha Khan");
    assert.equal(verified.eventSlug, "sample-event");
    assert.equal(findSampleCertificateByVerifyCode("UNKNOWN999"), null);
  });

  it("includes all 7 required organizer step-by-step guides, pilot banner flag, cookie-free analytics flag, sitemap, and robots", () => {
    assert.deepEqual(
      HELP_GUIDES.map((g) => g.id),
      [
        "create-event",
        "upload-template",
        "place-name",
        "import-attendees",
        "fix-name",
        "reset-download",
        "check-downloads",
      ],
    );

    assert.equal(isPilotBannerEnabled({}), true);
    assert.equal(isPilotBannerEnabled({ PILOT_BANNER_ENABLED: "false" }), false);

    assert.equal(isAnalyticsEnabled({}), false);
    assert.deepEqual(getCookieFreeAnalyticsConfig({}), {
      enabled: false,
      scriptSrc: null,
      domain: null,
    });
    assert.deepEqual(
      getCookieFreeAnalyticsConfig({
        ANALYTICS_ENABLED: "true",
        NEXT_PUBLIC_ANALYTICS_DOMAIN: "certsaas.pk",
      }),
      {
        enabled: true,
        scriptSrc: "https://plausible.io/js/script.js",
        domain: "certsaas.pk",
      },
    );

    const sitemapEntries = sitemap();
    const urls = sitemapEntries.map((e) => e.url);
    assert.ok(urls.some((u) => u.endsWith("/pricing")));
    assert.ok(urls.some((u) => u.endsWith("/help")));
    assert.ok(urls.some((u) => u.endsWith("/privacy")));
    assert.ok(urls.some((u) => u.endsWith("/terms")));
    assert.ok(urls.some((u) => u.endsWith("/contact")));
    assert.ok(urls.some((u) => u.endsWith("/e/sample-event")));

    const robotsRules = robots();
    assert.ok(String(robotsRules.sitemap).endsWith("/sitemap.xml"));

    // Verify required copy on /, PricingCardsSection, and /privacy
    const homeSrc = fs.readFileSync(
      path.join(process.cwd(), "src/app/page.tsx"),
      "utf8",
    );
    assert.match(homeSrc, /Issue certificates online, no printing/);

    const pricingCardSrc = fs.readFileSync(
      path.join(process.cwd(), "src/components/pricing/PricingCardsSection.tsx"),
      "utf8",
    );
    assert.match(
      pricingCardSrc,
      /Certificates stay downloadable for 12 months after release\./,
    );
    assert.match(
      pricingCardSrc,
      /Pilot: approved by our team, no payment needed yet/,
    );

    const privacySrc = fs.readFileSync(
      path.join(process.cwd(), "src/app/privacy/page.tsx"),
      "utf8",
    );
    assert.match(privacySrc, /Organizations own their attendee data/i);
    assert.match(privacySrc, /12 months after release/i);
    assert.match(privacySrc, /never sell/i);
  });
});

describe("Self-service data deletion (event data purge & full organization deletion)", () => {
  const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const EVENT_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  it("strips cross-tenant or traversal storage paths and purges event data + organization rows cleanly", async () => {
    const safe = filterSafeOrgPaths(ORG_A, [
      `${ORG_A}/${EVENT_A}/tpl.pdf`,
      `${ORG_B}/${EVENT_A}/foreign.pdf`,
      `${ORG_A}/../${ORG_B}/escape.pdf`,
      "",
      null,
    ]);
    assert.deepEqual(safe, [`${ORG_A}/${EVENT_A}/tpl.pdf`]);

    const removedBuckets: Array<{ bucket: string; paths: string[] }> = [];
    const deletedOrder: string[] = [];

    const eventPurgeRes = await executeEventDataPurge({
      orgId: ORG_A,
      eventId: EVENT_A,
      actorUserId: "u-1",
      adapter: {
        async getEventScopedPaths() {
          return {
            templatePaths: [
              `${ORG_A}/${EVENT_A}/cert.pdf`,
              `${ORG_B}/evil.pdf`,
            ],
            proofPaths: [`${ORG_A}/topup-1.png`],
          };
        },
        async removeStorageObjects(bucket, paths) {
          removedBuckets.push({ bucket, paths });
        },
        async purgeEventRows() {
          deletedOrder.push("event_rows_purged");
          return { attendeesDeleted: 42 };
        },
        async getOrgScopedPaths() {
          return { templatePaths: [], proofPaths: [] };
        },
        async purgeOrganizationRows() {},
      },
    });

    assert.equal(eventPurgeRes.attendeesDeleted, 42);
    assert.equal(eventPurgeRes.templateFilesRemoved, 1);
    assert.equal(eventPurgeRes.proofFilesRemoved, 1);
    assert.deepEqual(removedBuckets, [
      { bucket: "templates", paths: [`${ORG_A}/${EVENT_A}/cert.pdf`] },
      { bucket: "payment-proofs", paths: [`${ORG_A}/topup-1.png`] },
    ]);

    removedBuckets.length = 0;
    const orgDelRes = await executeOrganizationDeletion({
      orgId: ORG_A,
      adapter: {
        async getEventScopedPaths() {
          return { templatePaths: [], proofPaths: [] };
        },
        async purgeEventRows() {
          return { attendeesDeleted: 0 };
        },
        async getOrgScopedPaths() {
          return {
            templatePaths: [`${ORG_A}/${EVENT_A}/cert.pdf`],
            proofPaths: [`${ORG_A}/purchase-1.png`],
          };
        },
        async removeStorageObjects(bucket, paths) {
          removedBuckets.push({ bucket, paths });
        },
        async purgeOrganizationRows() {
          deletedOrder.push("org_rows_purged");
        },
      },
    });

    assert.equal(orgDelRes.templateFilesRemoved, 1);
    assert.equal(orgDelRes.proofFilesRemoved, 1);
    assert.ok(deletedOrder.includes("org_rows_purged"));
  });
});
