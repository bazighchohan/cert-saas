import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSafeCertificateFilename,
  normalizeForLookup,
  signLookupTokenWithSecret,
  verifyLookupTokenWithSecret,
} from "@/lib/public-event-helpers";

describe("public-event-helpers (case/space normalization, safe filenames, HMAC lookup tokens)", () => {
  it("normalizes identifiers and names case- and space-insensitively", () => {
    assert.equal(normalizeForLookup("  FA24-BSE-001  "), "fa24-bse-001");
    assert.equal(
      normalizeForLookup("  Muhammad   Abdul\tRehman  "),
      "muhammad abdul rehman",
    );
  });

  it("builds header-injection-safe attachment filenames", () => {
    const fn = buildSafeCertificateFilename(
      "ai-summit-2026",
      "participation",
      "FA24/BSE\"001\r\nEvil:1",
    );
    assert.equal(
      fn,
      "certificate-ai-summit-2026-participation-FA24_BSE_001_Evil_1.pdf",
    );
    assert.equal(/["\r\n/\\]/.test(fn), false);
  });

  it("signs and verifies lookup tokens and rejects tampered or expired tokens", () => {
    const secret = "test-secret-32-chars-minimum-value";
    const token = signLookupTokenWithSecret(
      {
        orgId: "org-1",
        eventId: "ev-1",
        slug: "ai-summit-2026",
        attendeeId: "att-1",
        identifierLower: "fa24-bse-001",
      },
      secret,
    );

    const verified = verifyLookupTokenWithSecret(token, secret);
    assert.ok(verified);
    assert.equal(verified.attendeeId, "att-1");
    assert.equal(verified.slug, "ai-summit-2026");

    // Wrong secret rejected
    assert.equal(verifyLookupTokenWithSecret(token, "wrong-secret"), null);

    // Tampered payload rejected
    const [, sig] = token.split(".");
    const fakeBody = Buffer.from(
      JSON.stringify({ ...verified, attendeeId: "att-other" }),
      "utf8",
    ).toString("base64url");
    assert.equal(verifyLookupTokenWithSecret(`${fakeBody}.${sig}`, secret), null);

    // Expired token rejected
    const expired = signLookupTokenWithSecret(
      {
        orgId: "org-1",
        eventId: "ev-1",
        slug: "ai-summit-2026",
        attendeeId: "att-1",
        identifierLower: "fa24-bse-001",
      },
      secret,
      -1000,
    );
    assert.equal(verifyLookupTokenWithSecret(expired, secret), null);
  });
});
