import "server-only";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { NAME_STYLES, TEMPLATE_FILE, type CertType, type NameStyle } from "@/lib/config";
import {
  computeNamePlacementPt,
  getFontFileForStyle,
  resolveCuratedFont,
} from "@/lib/fonts";
import { detectMagicMime, type TemplateMimeType } from "@/lib/template-validator";

const PUBLIC_DIR = path.join(process.cwd(), "public");

const fileCache = new Map<string, Promise<Uint8Array | null>>();

function readPublic(relPath: string): Promise<Uint8Array | null> {
  let p = fileCache.get(relPath);
  if (!p) {
    p = readFile(path.join(PUBLIC_DIR, relPath))
      .then((b) => new Uint8Array(b))
      .catch((err: NodeJS.ErrnoException) => {
        fileCache.delete(relPath);
        if (err.code === "ENOENT") return null;
        throw err;
      });
    fileCache.set(relPath, p);
  }
  return p;
}

async function loadFontBytes(fontFile: string): Promise<Uint8Array | null> {
  const configured = await readPublic(fontFile);
  if (configured) return configured;

  const files = await readdir(path.join(PUBLIC_DIR, "fonts")).catch(() => [] as string[]);
  const fallback = files.sort().find((f) => /\.(ttf|otf)$/i.test(f));
  return fallback ? readPublic(`fonts/${fallback}`) : null;
}

export function hexToRgbNormalized(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [11 / 255, 42 / 255, 79 / 255];
  }
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Verifies using fontkit whether the embedded TTF font contains glyphs for every
 * non-control code point in `text`.
 */
export async function checkServerFontGlyphSupport(
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
  const bytes = await loadFontBytes(fontFile);
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

export interface CustomCertificateRenderInput {
  templateBytes: Uint8Array;
  templateMime?: TemplateMimeType | null;
  pageIndex?: number;
  pageWidthPt?: number | null;
  pageHeightPt?: number | null;
  recipientName: string;
  nameXPt: number;
  nameYPt: number;
  maxNameWidthPt: number;
  nameFont: string;
  nameBold: boolean;
  nameSizePt: number;
  nameColorHex: string;
  nameAlign: "left" | "center" | "right";
}

export interface CustomCertificateRenderResult {
  pdfBytes: Uint8Array;
  pageWidthPt: number;
  pageHeightPt: number;
  effectiveFontSizePt: number;
  textWidthPt: number;
  textDrawXPt: number;
  baselineYPt: number;
  missingChars: string[];
}

/**
 * Multi-tenant certificate generator:
 * - Accepts a PDF, PNG, or JPG template buffer.
 * - Uses PDF-point coordinates (origin bottom-left, matching pdf-lib).
 * - Embeds the chosen curated TTF font via @pdf-lib/fontkit (with subset: false for
 *   non-ASCII / Arabic / Urdu text so all shaped glyphs embed cleanly).
 * - Applies the exact same auto-shrink and alignment formula as the browser canvas editor.
 */
export async function renderCustomCertificate(
  input: CustomCertificateRenderInput,
): Promise<CustomCertificateRenderResult> {
  const mime = input.templateMime || detectMagicMime(input.templateBytes);
  if (!mime) {
    throw new Error("Unsupported certificate template format.");
  }

  let pdf: PDFDocument;
  let targetPageIndex = 0;

  if (mime === "application/pdf") {
    pdf = await PDFDocument.load(input.templateBytes);
    const totalPages = pdf.getPageCount();
    if (totalPages < 1) {
      throw new Error("Template PDF has no pages.");
    }
    targetPageIndex =
      input.pageIndex !== undefined &&
      input.pageIndex >= 0 &&
      input.pageIndex < totalPages
        ? Math.floor(input.pageIndex)
        : 0;
  } else {
    pdf = await PDFDocument.create();
    const embeddedImage =
      mime === "image/png"
        ? await pdf.embedPng(input.templateBytes)
        : await pdf.embedJpg(input.templateBytes);

    const maxSide = Math.max(embeddedImage.width, embeddedImage.height);
    const scale = maxSide > 842 ? 842 / maxSide : 1;
    const widthPt =
      input.pageWidthPt && input.pageWidthPt > 0
        ? input.pageWidthPt
        : Number((embeddedImage.width * scale).toFixed(2));
    const heightPt =
      input.pageHeightPt && input.pageHeightPt > 0
        ? input.pageHeightPt
        : Number((embeddedImage.height * scale).toFixed(2));

    const page = pdf.addPage([widthPt, heightPt]);
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: widthPt,
      height: heightPt,
    });
    targetPageIndex = 0;
  }

  pdf.registerFontkit(fontkit);

  const pages = pdf.getPages();
  const targetPage = pages[targetPageIndex];
  const { width: pageWidthPt, height: pageHeightPt } = targetPage.getSize();

  const glyphCheck = await checkServerFontGlyphSupport(
    input.recipientName,
    input.nameFont,
    input.nameBold,
  );

  // If the selected font is missing glyphs for the recipient name (e.g. Urdu/Arabic
  // typed while a Latin-only font was kept), fall back to Amiri so pdf-lib never crashes,
  // while still reporting missingChars to the caller.
  const effectiveFontId =
    glyphCheck.supported
      ? input.nameFont
      : "amiri";

  const fontFile = getFontFileForStyle(effectiveFontId, input.nameBold);
  const fontBytes = await loadFontBytes(fontFile);

  // Use subset: false when non-ASCII characters are present so OpenType GSUB ligatures
  // and Arabic/Urdu presentation glyphs are never stripped by pdf-lib subsetting.
  const hasNonAscii = /[^\x00-\x7F]/.test(input.recipientName);
  const font: PDFFont = fontBytes
    ? await pdf.embedFont(fontBytes, { subset: !hasNonAscii })
    : await pdf.embedFont(StandardFonts.HelveticaBold);

  const computed = computeNamePlacementPt(
    {
      nameXPt: input.nameXPt,
      nameYPt: input.nameYPt,
      maxNameWidthPt: input.maxNameWidthPt,
      nameSizePt: input.nameSizePt,
      nameAlign: input.nameAlign,
    },
    (sizePt) => font.widthOfTextAtSize(input.recipientName, sizePt),
  );

  const [r, g, b] = hexToRgbNormalized(input.nameColorHex);

  targetPage.drawText(input.recipientName, {
    x: computed.textDrawXPt,
    y: computed.baselineYPt,
    size: computed.effectiveFontSizePt,
    font,
    color: rgb(r, g, b),
  });

  // Remove any other pages in a multi-page PDF after drawing
  for (let i = pages.length - 1; i >= 0; i--) {
    if (i !== targetPageIndex) {
      pdf.removePage(i);
    }
  }

  pdf.setTitle(`Certificate – ${input.recipientName}`);
  const pdfBytes = await pdf.save();

  return {
    pdfBytes,
    pageWidthPt: Number(pageWidthPt.toFixed(2)),
    pageHeightPt: Number(pageHeightPt.toFixed(2)),
    effectiveFontSizePt: computed.effectiveFontSizePt,
    textWidthPt: Number(computed.textWidthPt.toFixed(2)),
    textDrawXPt: Number(computed.textDrawXPt.toFixed(2)),
    baselineYPt: Number(computed.baselineYPt.toFixed(2)),
    missingChars: glyphCheck.missingChars,
  };
}

// -----------------------------------------------------------------------------
// Legacy single-event renderer (preserved for existing /api/certificate & /api/preview)
// -----------------------------------------------------------------------------
export interface RenderOverrides {
  nameY?: number;
  fontSize?: number;
  centerXRatio?: number;
}

export async function renderCertificate(
  certType: CertType,
  name: string,
  overrides: RenderOverrides = {},
): Promise<Uint8Array> {
  const style: NameStyle = { ...NAME_STYLES[certType], ...stripUndefined(overrides) };

  const templateBytes = await readPublic(TEMPLATE_FILE);
  if (!templateBytes) throw new Error(`Template not found: public/${TEMPLATE_FILE}`);

  const pdf = await PDFDocument.load(templateBytes);
  pdf.registerFontkit(fontkit);

  const pages = pdf.getPages();
  const pageCount = pages.length;

  if (style.pageIndex < 0 || style.pageIndex >= pageCount) {
    throw new Error(
      `Template has ${pageCount} page(s); configured pageIndex ${style.pageIndex} for '${certType}' does not exist.`,
    );
  }

  const targetPage = pages[style.pageIndex];
  const { width: pageWidth } = targetPage.getSize();

  const centerX = pageWidth * (style.centerXRatio ?? 0.665);
  const maxAllowedWidth = pageWidth * (style.maxWidthRatio ?? 0.55);

  const fontBytes = await loadFontBytes(style.fontFile);
  const font: PDFFont = fontBytes
    ? await pdf.embedFont(fontBytes, { subset: true })
    : await pdf.embedFont(StandardFonts.HelveticaBold);

  let size = style.fontSize;
  const naturalWidth = font.widthOfTextAtSize(name, size);
  if (naturalWidth > maxAllowedWidth) {
    size = (size * maxAllowedWidth) / naturalWidth;
  }
  const textWidth = font.widthOfTextAtSize(name, size);

  const textX = centerX - textWidth / 2;
  const textY = style.nameY;

  targetPage.drawText(name, {
    x: textX,
    y: textY,
    size,
    font,
    color: rgb(...style.color),
  });

  for (let i = pageCount - 1; i >= 0; i--) {
    if (i !== style.pageIndex) {
      pdf.removePage(i);
    }
  }

  pdf.setTitle(`Certificate – ${name}`);
  return pdf.save();
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
