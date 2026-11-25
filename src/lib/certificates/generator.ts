import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  computeNamePlacementPt,
  getFontFileForStyle,
  resolveCuratedFont,
} from "@/lib/fonts";
import { getCachedFontBytes, getCachedNormalizedTemplate } from "./cache";
import { stampVerificationQr } from "./qr";
import {
  CertificateValidationError,
  type CertificateTypePositioningRow,
  type GenerateCertificateDetailedResult,
  type GenerateCertificateInput,
} from "./types";

export function hexToRgbNormalized(hex: string | undefined | null): [number, number, number] {
  const clean = (hex ?? "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [11 / 255, 42 / 255, 79 / 255];
  }
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

/**
 * Checks whether the embedded TTF font contains glyphs for every printable
 * code point in `text`.
 */
export async function checkEmbeddedFontGlyphs(
  text: string,
  fontIdOrName: string,
  bold: boolean,
): Promise<{
  supported: boolean;
  missingChars: string[];
  fontLabel: string;
}> {
  const def = resolveCuratedFont(fontIdOrName);
  const fontFile = getFontFileForStyle(def.id, bold);
  const bytes = await getCachedFontBytes(fontFile);
  if (!bytes) {
    return { supported: true, missingChars: [], fontLabel: def.label };
  }

  try {
    const fkFont = fontkit.create(Buffer.from(bytes));
    const missing = new Set<string>();
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined || cp <= 0x20) continue;
      if (!fkFont.hasGlyphForCodePoint(cp)) {
        missing.add(ch);
      }
    }
    return {
      supported: missing.size === 0,
      missingChars: Array.from(missing),
      fontLabel: def.label,
    };
  } catch {
    return { supported: true, missingChars: [], fontLabel: def.label };
  }
}

interface NormalizedRowConfig {
  label: string;
  templateMime: string | null;
  pageIndex: number;
  hintWidthPt: number | null;
  hintHeightPt: number | null;
  rawNameX: number;
  rawNameY: number;
  rawMaxNameWidth: number;
  nameFont: string;
  nameBold: boolean;
  nameSizePt: number;
  nameColorHex: string;
  nameAlign: "left" | "center" | "right";
}

function readPositioningFromRow(row: CertificateTypePositioningRow): NormalizedRowConfig {
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const hintWidthPt = numOrNull(row.pageWidthPt ?? row.page_width_pt);
  const hintHeightPt = numOrNull(row.pageHeightPt ?? row.page_height_pt);
  const pageIndex = Math.max(0, Math.floor(numOrNull(row.pageIndex ?? row.page_index) ?? 0));

  const rawNameX = numOrNull(row.nameX ?? row.name_x);
  const rawNameY = numOrNull(row.nameY ?? row.name_y);
  const rawMaxNameWidth = numOrNull(row.maxNameWidth ?? row.max_name_width);

  if (rawNameX === null || rawNameY === null || rawMaxNameWidth === null) {
    throw new CertificateValidationError(
      "certificate_types row must provide name_x, name_y, and max_name_width.",
    );
  }

  const rawSize = numOrNull(row.nameSize ?? row.name_size) ?? 34;
  const nameSizePt = Math.max(4, Math.min(300, rawSize));

  const alignRaw = String(row.nameAlign ?? row.name_align ?? "center").toLowerCase();
  const nameAlign: "left" | "center" | "right" =
    alignRaw === "left" || alignRaw === "right" ? alignRaw : "center";

  const nameBold =
    row.nameBold !== undefined
      ? Boolean(row.nameBold)
      : row.name_bold !== undefined
        ? Boolean(row.name_bold)
        : true;

  return {
    label: (row.label ?? "Certificate").trim() || "Certificate",
    templateMime: (row.templateMime ?? row.template_mime ?? null) as string | null,
    pageIndex,
    hintWidthPt,
    hintHeightPt,
    rawNameX,
    rawNameY,
    rawMaxNameWidth,
    nameFont: String(row.nameFont ?? row.name_font ?? "times"),
    nameBold,
    nameSizePt,
    nameColorHex: String(row.nameColor ?? row.name_color ?? "#0B2A4F"),
    nameAlign,
  };
}

/**
 * Detailed certificate generator returning both the PDF bytes and computed layout metrics.
 */
export async function generateCertificateDetailed({
  templateBytes,
  config,
  fullName,
  verifyCode,
}: GenerateCertificateInput): Promise<GenerateCertificateDetailedResult> {
  if (!templateBytes || templateBytes.byteLength === 0) {
    throw new CertificateValidationError("Template bytes must not be empty.");
  }

  if (typeof fullName !== "string") {
    throw new CertificateValidationError("Recipient full name is required.");
  }

  const cleanName = fullName.trim().replace(/\s+/g, " ");
  if (!cleanName) {
    throw new CertificateValidationError("Recipient full name must not be empty.");
  }

  const rowCfg = readPositioningFromRow(config.certificateType);

  // 1. Load pre-normalized 1-page base template from per-instance cache
  const baseTemplate = await getCachedNormalizedTemplate({
    templateBytes,
    declaredMime: rowCfg.templateMime,
    pageIndex: rowCfg.pageIndex,
    hintWidthPt: rowCfg.hintWidthPt,
    hintHeightPt: rowCfg.hintHeightPt,
  });

  const pdf = await PDFDocument.load(baseTemplate.singlePagePdfBytes, {
    updateMetadata: false,
  });
  pdf.registerFontkit(fontkit);

  const page = pdf.getPage(0);
  const { width: pageWidthPt, height: pageHeightPt } = page.getSize();

  // Convert legacy 0..1 fractional rows seamlessly if encountered
  const nameXPt =
    rowCfg.rawNameX <= 1 && rowCfg.rawNameX > 0
      ? Number((pageWidthPt * rowCfg.rawNameX).toFixed(2))
      : rowCfg.rawNameX;
  const nameYPt =
    rowCfg.rawNameY <= 1 && rowCfg.rawNameY > 0
      ? Number((pageHeightPt * (1 - rowCfg.rawNameY)).toFixed(2))
      : rowCfg.rawNameY;
  const maxNameWidthPt =
    rowCfg.rawMaxNameWidth <= 1 && rowCfg.rawMaxNameWidth > 0
      ? Number((pageWidthPt * rowCfg.rawMaxNameWidth).toFixed(2))
      : rowCfg.rawMaxNameWidth;

  // 2. Check glyph coverage & embed subsetted TTF font (keeps generated PDFs small, ~15-60 KB)
  const glyphCheck = await checkEmbeddedFontGlyphs(
    cleanName,
    rowCfg.nameFont,
    rowCfg.nameBold,
  );
  const effectiveFontId = glyphCheck.supported ? rowCfg.nameFont : "amiri";
  const fontFile = getFontFileForStyle(effectiveFontId, rowCfg.nameBold);
  const fontBytes = await getCachedFontBytes(fontFile);

  let font: PDFFont;
  if (fontBytes) {
    try {
      font = await pdf.embedFont(fontBytes, { subset: true });
      // Verify width measurement succeeds with subsetting; if fontkit subsetting hits an
      // OpenType GSUB edge case on complex scripts, fall back to non-subsetted embed.
      font.widthOfTextAtSize(cleanName, rowCfg.nameSizePt);
    } catch {
      font = await pdf.embedFont(fontBytes, { subset: false });
    }
  } else {
    font = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  // 3. Compute exact PDF-point placement & auto-shrink from certificate_types row
  const computed = computeNamePlacementPt(
    {
      nameXPt,
      nameYPt,
      maxNameWidthPt,
      nameSizePt: rowCfg.nameSizePt,
      nameAlign: rowCfg.nameAlign,
    },
    (sizePt) => font.widthOfTextAtSize(cleanName, sizePt),
  );

  const [r, g, b] = hexToRgbNormalized(rowCfg.nameColorHex);

  page.drawText(cleanName, {
    x: computed.textDrawXPt,
    y: computed.baselineYPt,
    size: computed.effectiveFontSizePt,
    font,
    color: rgb(r, g, b),
  });

  // 4. Optional QR + short verify code stamp controlled by event setting `show_qr`
  const trimmedVerifyCode = verifyCode?.trim() ?? "";
  const shouldStampQr = Boolean(config.showQr && trimmedVerifyCode);
  if (shouldStampQr) {
    await stampVerificationQr({
      pdf,
      page,
      verifyCode: trimmedVerifyCode,
      verifyBaseUrl: config.verifyBaseUrl,
      position: config.qrPosition ?? "bottom-right",
      customXPt: config.qrXPt,
      customYPt: config.qrYPt,
      qrSizePt: config.qrSizePt ?? 54,
    });
  }

  // 5. Embed PDF metadata (Title, Author = org name, Subject = event title)
  const titleParts = [
    config.eventTitle?.trim() || rowCfg.label,
    cleanName,
  ].filter(Boolean);
  pdf.setTitle(titleParts.join(" – "));
  if (config.orgName?.trim()) {
    pdf.setAuthor(config.orgName.trim());
  }
  if (config.eventTitle?.trim()) {
    pdf.setSubject(config.eventTitle.trim());
  }
  pdf.setCreator("cert-saas");
  pdf.setProducer("cert-saas");
  pdf.setCreationDate(new Date());

  const pdfBytes = await pdf.save({ useObjectStreams: true });

  return {
    pdfBytes,
    pageWidthPt: Number(pageWidthPt.toFixed(2)),
    pageHeightPt: Number(pageHeightPt.toFixed(2)),
    effectiveFontSizePt: computed.effectiveFontSizePt,
    textWidthPt: Number(computed.textWidthPt.toFixed(2)),
    textDrawXPt: Number(computed.textDrawXPt.toFixed(2)),
    baselineYPt: Number(computed.baselineYPt.toFixed(2)),
    missingChars: glyphCheck.missingChars,
    qrStamped: shouldStampQr,
  };
}

/**
 * Pure certificate generator:
 *   generateCertificate({ templateBytes, config, fullName, verifyCode? }) -> Promise<Uint8Array>
 */
export async function generateCertificate(
  input: GenerateCertificateInput,
): Promise<Uint8Array> {
  const res = await generateCertificateDetailed(input);
  return res.pdfBytes;
}
