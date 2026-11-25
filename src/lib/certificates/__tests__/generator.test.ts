import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  CertificateValidationError,
  clearCertificateCaches,
  generateCertificate,
  generateCertificateDetailed,
  getCertificateCacheStats,
  type CertificateGenerationConfig,
} from "@/lib/certificates";

const SAMPLE_TEMPLATE_PATH = path.join(
  process.cwd(),
  "public",
  "samples",
  "blank-template.pdf",
);

const BASE_CERT_TYPE_ROW = {
  label: "Certificate of Participation",
  template_mime: "application/pdf" as const,
  page_index: 0,
  page_width_pt: 843.75,
  page_height_pt: 597.75,
  name_x: 561.09,
  name_y: 265,
  max_name_width: 340,
  name_font: "lato",
  name_bold: true,
  name_size: 36,
  name_color: "#0B2A4F",
  name_align: "center" as const,
};

function makeConfig(
  overrides: Partial<CertificateGenerationConfig> = {},
): CertificateGenerationConfig {
  return {
    certificateType: { ...BASE_CERT_TYPE_ROW, ...overrides.certificateType },
    orgName: "FAST Computing Society",
    eventTitle: "National AI Seminar 2026",
    showQr: false,
    ...overrides,
  };
}

describe("generateCertificate()", () => {
  let templateBytes: Uint8Array;

  beforeEach(async () => {
    if (!templateBytes) {
      templateBytes = new Uint8Array(await readFile(SAMPLE_TEMPLATE_PATH));
    }
  });

  it("renders a normal name, embeds org/title metadata, and stays well under 300 KB", async () => {
    const pdfBytes = await generateCertificate({
      templateBytes,
      config: makeConfig(),
      fullName: "Bazigh Ali",
    });

    assert.ok(pdfBytes instanceof Uint8Array);
    assert.ok(pdfBytes.byteLength > 1_000, "PDF should be non-trivial");
    assert.ok(
      pdfBytes.byteLength < 300 * 1024,
      `Expected PDF < 300 KB, got ${Math.round(pdfBytes.byteLength / 1024)} KB`,
    );

    // Check PDF header (%PDF-)
    const header = Buffer.from(pdfBytes.slice(0, 5)).toString("ascii");
    assert.equal(header, "%PDF-");

    // Verify metadata & single-page output by reloading in pdf-lib
    const parsed = await PDFDocument.load(pdfBytes);
    assert.equal(parsed.getPageCount(), 1);
    assert.equal(parsed.getAuthor(), "FAST Computing Society");
    assert.equal(parsed.getTitle(), "National AI Seminar 2026 – Bazigh Ali");
    assert.equal(parsed.getSubject(), "National AI Seminar 2026");
  });

  it("auto-shrinks a very long name to fit max_name_width from the certificate_types row", async () => {
    const longName =
      "Syed Muhammad Abdul Rehman Bin Tariq Mahmood Al-Hashimi";

    const detailed = await generateCertificateDetailed({
      templateBytes,
      config: makeConfig({
        certificateType: {
          ...BASE_CERT_TYPE_ROW,
          max_name_width: 260,
          name_size: 38,
        },
      }),
      fullName: longName,
    });

    assert.ok(
      detailed.effectiveFontSizePt < 38,
      `Expected auto-shrink below 38pt, got ${detailed.effectiveFontSizePt}pt`,
    );
    assert.ok(
      detailed.textWidthPt <= 260.05,
      `Expected rendered textWidthPt (${detailed.textWidthPt}) <= max_name_width (260)`,
    );
    assert.ok(detailed.pdfBytes.byteLength < 300 * 1024);

    const parsed = await PDFDocument.load(detailed.pdfBytes);
    assert.equal(parsed.getPageCount(), 1);
  });

  it("renders names with Latin diacritics cleanly without missing glyphs", async () => {
    const diacriticName = "José María Núñez-Öztürk & Łukasz Żółć";

    const detailed = await generateCertificateDetailed({
      templateBytes,
      config: makeConfig({
        certificateType: {
          ...BASE_CERT_TYPE_ROW,
          name_font: "lato",
          max_name_width: 440,
        },
      }),
      fullName: diacriticName,
    });

    assert.deepEqual(detailed.missingChars, []);
    assert.ok(detailed.pdfBytes.byteLength < 300 * 1024);

    const parsed = await PDFDocument.load(detailed.pdfBytes);
    assert.equal(parsed.getPageCount(), 1);
    assert.equal(
      parsed.getTitle(),
      `National AI Seminar 2026 – ${diacriticName}`,
    );
  });

  it("rejects empty or whitespace-only names with CertificateValidationError", async () => {
    for (const badName of ["", "   ", "\t\n  "]) {
      await assert.rejects(
        () =>
          generateCertificate({
            templateBytes,
            config: makeConfig(),
            fullName: badName,
          }),
        (err: unknown) => {
          assert.ok(err instanceof CertificateValidationError);
          assert.match(err.message, /must not be empty/i);
          return true;
        },
      );
    }
  });

  it("stamps a QR code and /verify/{code} link when show_qr is true, at configurable positions", async () => {
    for (const pos of [
      "bottom-right",
      "bottom-left",
      "top-right",
      "top-left",
    ] as const) {
      const detailed = await generateCertificateDetailed({
        templateBytes,
        config: makeConfig({
          showQr: true,
          qrPosition: pos,
          verifyBaseUrl: "https://cert-saas.vercel.app",
        }),
        fullName: "Areeba Khan",
        verifyCode: "ABC123VERIFY",
      });

      assert.equal(detailed.qrStamped, true);
      assert.ok(detailed.pdfBytes.byteLength < 300 * 1024);

      const parsed = await PDFDocument.load(detailed.pdfBytes);
      const page = parsed.getPage(0);
      const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      assert.ok(annots && annots.size() >= 1, `Expected clickable URI link annotation for ${pos}`);
      const firstAnnot = parsed.context.lookup(annots.get(0), PDFDict);
      assert.ok(firstAnnot.toString().includes("/verify/ABC123VERIFY"));
    }
  });

  it("caches fonts and normalized templates across calls in the same server instance", async () => {
    clearCertificateCaches();
    const before = getCertificateCacheStats();
    assert.equal(before.templateCacheHits, 0);

    await generateCertificate({
      templateBytes,
      config: makeConfig(),
      fullName: "First Attendee",
    });
    await generateCertificate({
      templateBytes,
      config: makeConfig(),
      fullName: "Second Attendee",
    });

    const after = getCertificateCacheStats();
    assert.equal(after.cachedTemplates, 1);
    assert.ok(after.templateCacheHits >= 1, "Second render must hit template cache");
    assert.ok(after.fontCacheHits >= 1, "Second render must hit font cache");
  });
});
