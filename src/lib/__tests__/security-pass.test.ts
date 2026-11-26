import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  AddAttendeeInputSchema,
  EventSlugParamSchema,
  ImportPreviewBodySchema,
  PaymentUpgradeFieldsSchema,
  PublicDownloadBodySchema,
  SignupInputSchema,
  UuidSchema,
  VerifyCodeSchema,
} from "../schemas";
import {
  assertOrgScopedStoragePath,
  clampSignedUrlTtl,
  InvalidJsonBodyError,
  MAX_SIGNED_URL_TTL_SECONDS,
  PayloadTooLargeError,
  readBoundedJson,
  sanitizeClientErrorMessage,
  verifySameOriginRequest,
} from "../security-helpers";

describe("CSRF same-origin verification on cookie-authenticated mutations", () => {
  it("allows GET/HEAD requests and same-origin POST/PUT/DELETE, and blocks cross-origin or missing Origin/Referer", () => {
    // Safe read method always allowed
    assert.deepEqual(
      verifySameOriginRequest({
        method: "GET",
        originHeader: null,
        refererHeader: null,
        hostHeader: "app.cert-saas.com",
      }),
      { ok: true },
    );

    // Same-origin POST allowed
    assert.deepEqual(
      verifySameOriginRequest({
        method: "POST",
        originHeader: "https://app.cert-saas.com",
        refererHeader: null,
        hostHeader: "app.cert-saas.com",
        secFetchSiteHeader: "same-origin",
      }),
      { ok: true },
    );

    // Cross-origin Origin blocked
    const crossOrigin = verifySameOriginRequest({
      method: "POST",
      originHeader: "https://evil-attacker.example",
      refererHeader: "https://evil-attacker.example/csrf.html",
      hostHeader: "app.cert-saas.com",
    });
    assert.equal(crossOrigin.ok, false);

    // Sec-Fetch-Site: cross-site blocked even if Origin omitted
    const secFetchCross = verifySameOriginRequest({
      method: "DELETE",
      originHeader: null,
      refererHeader: null,
      hostHeader: "app.cert-saas.com",
      secFetchSiteHeader: "cross-site",
    });
    assert.equal(secFetchCross.ok, false);

    // Missing both Origin and Referer on POST blocked
    const missingHeaders = verifySameOriginRequest({
      method: "POST",
      originHeader: null,
      refererHeader: null,
      hostHeader: "app.cert-saas.com",
    });
    assert.equal(missingHeaders.ok, false);
  });
});

describe("Bounded JSON body reader & Zod input validation", () => {
  it("rejects oversized request bodies with 413 PayloadTooLargeError before parsing", async () => {
    const huge = "x".repeat(5000);
    const req = new Request("https://app.cert-saas.com/api/test", {
      method: "POST",
      body: JSON.stringify({ data: huge }),
      headers: { "Content-Type": "application/json" },
    });

    await assert.rejects(
      () => readBoundedJson(req, 1024),
      (err: unknown) =>
        err instanceof PayloadTooLargeError && err.httpStatus === 413,
    );

    const badJsonReq = new Request("https://app.cert-saas.com/api/test", {
      method: "POST",
      body: "{not-valid-json",
    });
    await assert.rejects(
      () => readBoundedJson(badJsonReq, 4096),
      (err: unknown) =>
        err instanceof InvalidJsonBodyError && err.httpStatus === 400,
    );
  });

  it("validates UUIDs, slugs, verify codes, auth inputs, and import rows with Zod", () => {
    assert.equal(UuidSchema.safeParse("not-a-uuid").success, false);
    assert.equal(
      UuidSchema.safeParse("11111111-1111-4111-8111-111111111111").success,
      true,
    );

    assert.equal(
      EventSlugParamSchema.safeParse("../admin/secret").success,
      false,
    );
    assert.equal(EventSlugParamSchema.safeParse("ai-summit-2026").success, true);

    assert.equal(VerifyCodeSchema.safeParse("DROP TABLE;--").success, false);
    assert.equal(VerifyCodeSchema.safeParse("AB12CD34EF").success, true);

    assert.equal(
      SignupInputSchema.safeParse({
        orgName: "A",
        email: "bad-email",
        password: "short",
      }).success,
      false,
    );

    assert.equal(
      PaymentUpgradeFieldsSchema.safeParse({
        planId: "starter",
        paymentMethod: "crypto", // invalid enum
        transactionReference: "TID12345",
      }).success,
      false,
    );

    assert.equal(
      PublicDownloadBodySchema.safeParse({
        token: "short",
        attendeeCertificateId: "invalid",
      }).success,
      false,
    );

    assert.equal(
      AddAttendeeInputSchema.safeParse({
        eventId: "11111111-1111-4111-8111-111111111111",
        identifier: "CS-001",
        fullName: "Valid Student",
        certificateTypeIds: ["not-a-uuid"],
      }).success,
      false,
    );

    assert.equal(
      ImportPreviewBodySchema.safeParse({
        rows: [],
        mapping: {},
      }).success,
      false,
    );
  });
});

describe("Safe client error sanitization & Storage privacy/TTL guards", () => {
  it("strips SQL constraint names, table/column leaks, and stack traces from user-facing errors", () => {
    const sqlLeak = new Error(
      'null value in column "org_id" of relation "attendees" violates not-null constraint',
    );
    assert.equal(
      sanitizeClientErrorMessage(sqlLeak, "Could not save attendee."),
      "Could not save attendee.",
    );

    const rlsLeak = new Error(
      'new row violates row-level security policy for table "events"',
    );
    assert.equal(
      sanitizeClientErrorMessage(rlsLeak, "Access denied."),
      "Access denied.",
    );

    const stackLeak = new Error(
      "Unexpected error\n    at Object.POST (/var/task/src/app/api/route.js:42:13)",
    );
    assert.equal(
      sanitizeClientErrorMessage(stackLeak, "Request failed."),
      "Request failed.",
    );

    // Friendly domain messages pass through intact
    assert.equal(
      sanitizeClientErrorMessage(
        new Error("Plan limit reached: max 1 event on Free plan."),
      ),
      "Plan limit reached: max 1 event on Free plan.",
    );
  });

  it("clamps signed Storage URL TTLs to <= 60 seconds and blocks cross-org template paths", async () => {
    assert.equal(clampSignedUrlTtl(3600), MAX_SIGNED_URL_TTL_SECONDS);
    assert.equal(clampSignedUrlTtl(86400), 60);
    assert.equal(clampSignedUrlTtl(30), 30);

    const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const eventA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    // Attempting to access Org B's template path or path traversal while scoped to Org A is rejected
    assert.throws(
      () =>
        assertOrgScopedStoragePath({
          orgId: orgA,
          eventId: eventA,
          objectPath: `${orgB}/${eventA}/stolen-template.pdf`,
        }),
      /does not belong to the current organization/i,
    );
    assert.throws(
      () =>
        assertOrgScopedStoragePath({
          orgId: orgA,
          eventId: eventA,
          objectPath: `${orgA}/${eventA}/../../${orgB}/stolen.pdf`,
        }),
      /does not belong to the current organization/i,
    );
  });

  it("verifies retired unscoped legacy routes no longer import getSupabaseAdmin", () => {
    const retiredRoutes = [
      "src/app/api/certificate/route.ts",
      "src/app/api/admin/attendees/route.ts",
      "src/app/api/admin/attendees/[id]/route.ts",
      "src/app/api/admin/attendees/manual/route.ts",
      "src/app/api/admin/attendees/by-roll/[rollNo]/route.ts",
      "src/app/api/admin/attendees/by-roll/[rollNo]/edit/route.ts",
      "src/app/api/admin/attendees/by-roll/[rollNo]/society/route.ts",
      "src/app/api/admin/export/downloaded/route.ts",
      "src/app/api/admin/settings/route.ts",
      "src/app/api/admin/society-sync/route.ts",
      "src/app/api/admin/upload/preview/route.ts",
      "src/app/api/admin/upload/confirm/route.ts",
    ];

    for (const relPath of retiredRoutes) {
      const src = fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
      assert.ok(
        !src.includes("getSupabaseAdmin"),
        `Expected retired route ${relPath} not to call getSupabaseAdmin`,
      );
      assert.ok(
        src.includes("retiredLegacyEndpointResponse"),
        `Expected retired route ${relPath} to return retiredLegacyEndpointResponse()`,
      );
    }
  });
});
