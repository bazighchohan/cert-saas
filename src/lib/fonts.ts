/**
 * Curated list of embedded TTF fonts bundled in /public/fonts.
 * Used by both the browser canvas name-placement editor and the server pdf-lib renderer.
 */

export type CuratedFontId =
  | "times"
  | "georgia"
  | "lato"
  | "great-vibes"
  | "amiri";

export interface CuratedFontDefinition {
  id: CuratedFontId;
  label: string;
  category: "serif" | "sans" | "script" | "arabic-urdu";
  regularFile: string;
  boldFile: string;
  supportsBoldToggle: boolean;
  /** True if the font includes Arabic & Urdu Unicode blocks (U+0600..U+06FF, U+FB50..U+FEFF). */
  supportsArabicUrdu: boolean;
}

export const CURATED_FONTS: CuratedFontDefinition[] = [
  {
    id: "times",
    label: "Times New Roman (Classic Serif)",
    category: "serif",
    regularFile: "fonts/TimesNewRoman-Bold.ttf",
    boldFile: "fonts/TimesNewRoman-Bold.ttf",
    supportsBoldToggle: false,
    supportsArabicUrdu: true,
  },
  {
    id: "georgia",
    label: "Georgia (Editorial Serif)",
    category: "serif",
    regularFile: "fonts/Georgia-Bold.ttf",
    boldFile: "fonts/Georgia-Bold.ttf",
    supportsBoldToggle: false,
    supportsArabicUrdu: false,
  },
  {
    id: "lato",
    label: "Lato (Modern Sans-Serif)",
    category: "sans",
    regularFile: "fonts/Lato-Regular.ttf",
    boldFile: "fonts/Lato-Bold.ttf",
    supportsBoldToggle: true,
    supportsArabicUrdu: false,
  },
  {
    id: "great-vibes",
    label: "Great Vibes (Calligraphy Script)",
    category: "script",
    regularFile: "fonts/GreatVibes-Regular.ttf",
    boldFile: "fonts/GreatVibes-Regular.ttf",
    supportsBoldToggle: false,
    supportsArabicUrdu: false,
  },
  {
    id: "amiri",
    label: "Amiri Naskh (Urdu / Arabic & Serif)",
    category: "arabic-urdu",
    regularFile: "fonts/Amiri-Regular.ttf",
    boldFile: "fonts/Amiri-Bold.ttf",
    supportsBoldToggle: true,
    supportsArabicUrdu: true,
  },
];

const LEGACY_FONT_MAP: Record<string, CuratedFontId> = {
  "TimesNewRoman-Bold": "times",
  "fonts/TimesNewRoman-Bold.ttf": "times",
  "Georgia-Bold": "georgia",
  "fonts/Georgia-Bold.ttf": "georgia",
  "Lato-Regular": "lato",
  "Lato-Bold": "lato",
  "GreatVibes-Regular": "great-vibes",
  "Amiri-Regular": "amiri",
  "Amiri-Bold": "amiri",
};

export function resolveCuratedFont(fontIdOrName: string | null | undefined): CuratedFontDefinition {
  if (!fontIdOrName) return CURATED_FONTS[0];
  const direct = CURATED_FONTS.find((f) => f.id === fontIdOrName);
  if (direct) return direct;
  const mappedId = LEGACY_FONT_MAP[fontIdOrName];
  if (mappedId) {
    const mapped = CURATED_FONTS.find((f) => f.id === mappedId);
    if (mapped) return mapped;
  }
  return CURATED_FONTS[0];
}

export function getFontFileForStyle(
  fontIdOrName: string | null | undefined,
  bold: boolean,
): string {
  const def = resolveCuratedFont(fontIdOrName);
  return bold ? def.boldFile : def.regularFile;
}

/**
 * Detects whether a string contains Arabic or Urdu script characters.
 */
export function containsArabicOrUrdu(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
    text,
  );
}

/**
 * Checks whether a sample name contains characters unsupported by the selected font
 * (client-side instant check; server also verifies exact glyph coverage via fontkit).
 */
export function checkClientFontGlyphSupport(
  text: string,
  fontIdOrName: string | null | undefined,
): {
  supported: boolean;
  warning?: string;
  suggestedFontId?: CuratedFontId;
} {
  const def = resolveCuratedFont(fontIdOrName);
  if (!text.trim()) return { supported: true };

  if (containsArabicOrUrdu(text) && !def.supportsArabicUrdu) {
    return {
      supported: false,
      suggestedFontId: "amiri",
      warning: `"${def.label}" does not include glyphs for Urdu/Arabic characters in this name. Switch to "Amiri Naskh (Urdu / Arabic & Serif)" or "Times New Roman" so all characters render properly.`,
    };
  }

  // Check for non-Latin scripts outside Latin / Extended Latin / Arabic when a Latin font is selected
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isAsciiOrLatinExt = cp <= 0x024f || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2000 && cp <= 0x206f);
    const isArabicBlock =
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x0750 && cp <= 0x077f) ||
      (cp >= 0xfb50 && cp <= 0xfdff) ||
      (cp >= 0xfe70 && cp <= 0xfeff);

    if (!isAsciiOrLatinExt && !(isArabicBlock && def.supportsArabicUrdu)) {
      return {
        supported: false,
        suggestedFontId: "amiri",
        warning: `"${def.label}" may not contain a glyph for "${ch}" (U+${cp
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}). Try "Amiri Naskh" or verify with "Download test PDF".`,
      };
    }
  }

  return { supported: true };
}

/**
 * Pure coordinate and auto-shrink math shared between the browser canvas editor
 * and the server pdf-lib certificate renderer.
 *
 * PDF coordinate system (pdf-lib):
 *   Origin (0, 0) is bottom-left of the page.
 *   nameXPt: anchor X in points from left edge (left, center, or right depending on align).
 *   nameYPt: alphabetic text baseline Y in points from bottom edge.
 *   maxNameWidthPt: maximum allowed text width in points.
 *
 * Screen canvas coordinate system:
 *   Origin (0, 0) is top-left of the canvas.
 *   scale = canvasWidthPx / pageWidthPt = canvasHeightPx / pageHeightPt.
 */
export interface NamePlacementPt {
  nameXPt: number;
  nameYPt: number;
  maxNameWidthPt: number;
  nameSizePt: number;
  nameAlign: "left" | "center" | "right";
}

export interface ComputedTextPlacementPt {
  /** Final font size in points after auto-shrink to fit maxNameWidthPt. */
  effectiveFontSizePt: number;
  /** Final rendered text width in points at effectiveFontSizePt. */
  textWidthPt: number;
  /** Left X coordinate in points where pdf-lib / canvas starts drawing text. */
  textDrawXPt: number;
  /** Baseline Y coordinate in points from bottom (pdf-lib y). */
  baselineYPt: number;
  /** Bounding box left X in points (for the interactive max-width box). */
  boxLeftPt: number;
  /** True if the text was shrunk to fit maxNameWidthPt. */
  wasShrunk: boolean;
}

export function computeNamePlacementPt(
  placement: NamePlacementPt,
  measureWidthAtSizePt: (fontSizePt: number) => number,
): ComputedTextPlacementPt {
  const maxW = Math.max(10, placement.maxNameWidthPt);
  const baseSize = Math.max(4, Math.min(300, placement.nameSizePt));
  const naturalWidth = measureWidthAtSizePt(baseSize);

  let effectiveFontSizePt = baseSize;
  let wasShrunk = false;
  if (naturalWidth > maxW && naturalWidth > 0) {
    effectiveFontSizePt = Number(((baseSize * maxW) / naturalWidth).toFixed(3));
    wasShrunk = true;
  }

  const textWidthPt = measureWidthAtSizePt(effectiveFontSizePt);

  let boxLeftPt: number;
  let textDrawXPt: number;
  if (placement.nameAlign === "left") {
    boxLeftPt = placement.nameXPt;
    textDrawXPt = placement.nameXPt;
  } else if (placement.nameAlign === "right") {
    boxLeftPt = placement.nameXPt - maxW;
    textDrawXPt = placement.nameXPt - textWidthPt;
  } else {
    boxLeftPt = placement.nameXPt - maxW / 2;
    textDrawXPt = placement.nameXPt - textWidthPt / 2;
  }

  return {
    effectiveFontSizePt,
    textWidthPt,
    textDrawXPt,
    baselineYPt: placement.nameYPt,
    boxLeftPt,
    wasShrunk,
  };
}

export function pdfPointToScreenPx(
  xPt: number,
  yPt: number,
  pageHeightPt: number,
  scale: number,
): { xPx: number; yPx: number } {
  return {
    xPx: xPt * scale,
    yPx: (pageHeightPt - yPt) * scale,
  };
}

export function screenPxToPdfPoint(
  xPx: number,
  yPx: number,
  pageHeightPt: number,
  scale: number,
): { xPt: number; yPt: number } {
  if (scale <= 0) return { xPt: 0, yPt: 0 };
  return {
    xPt: Number((xPx / scale).toFixed(2)),
    yPt: Number((pageHeightPt - yPx / scale).toFixed(2)),
  };
}
