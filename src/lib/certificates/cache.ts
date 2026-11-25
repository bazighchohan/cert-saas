import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MAX_CACHED_TEMPLATES = 48;

export interface NormalizedTemplateCacheEntry {
  singlePagePdfBytes: Uint8Array;
  pageWidthPt: number;
  pageHeightPt: number;
}

// Per-server-instance caches
const fontBytesCache = new Map<string, Promise<Uint8Array | null>>();
const normalizedTemplateCache = new Map<string, Promise<NormalizedTemplateCacheEntry>>();

let fontCacheHits = 0;
let templateCacheHits = 0;

function readPublicFontFile(relPath: string): Promise<Uint8Array | null> {
  const existing = fontBytesCache.get(relPath);
  if (existing) {
    fontCacheHits++;
    return existing;
  }

  const p = readFile(path.join(PUBLIC_DIR, relPath))
    .then((buf) => new Uint8Array(buf))
    .catch((err: NodeJS.ErrnoException) => {
      fontBytesCache.delete(relPath);
      if (err.code === "ENOENT") return null;
      throw err;
    });

  fontBytesCache.set(relPath, p);
  return p;
}

/**
 * Loads and caches embedded TTF font bytes per server instance.
 */
export async function getCachedFontBytes(fontFile: string): Promise<Uint8Array | null> {
  const direct = await readPublicFontFile(fontFile);
  if (direct) return direct;

  const files = await readdir(path.join(PUBLIC_DIR, "fonts")).catch(() => [] as string[]);
  const fallback = files.sort().find((f) => /\.(ttf|otf)$/i.test(f));
  return fallback ? readPublicFontFile(`fonts/${fallback}`) : null;
}

function detectMimeFromBytes(
  bytes: Uint8Array,
): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (bytes.length < 8) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return null;
}

/**
 * Parses and normalizes a template (extracting the target page of a PDF or
 * embedding a PNG/JPG onto a single PDF page) and caches the clean 1-page PDF
 * bytes per server instance so repeat certificate generations skip heavy template parsing.
 */
export function getCachedNormalizedTemplate(params: {
  templateBytes: Uint8Array;
  declaredMime?: string | null;
  pageIndex: number;
  hintWidthPt?: number | null;
  hintHeightPt?: number | null;
}): Promise<NormalizedTemplateCacheEntry> {
  const hash = createHash("sha256")
    .update(params.templateBytes)
    .update(
      `|p=${params.pageIndex}|w=${params.hintWidthPt ?? ""}|h=${params.hintHeightPt ?? ""}`,
    )
    .digest("hex");

  const existing = normalizedTemplateCache.get(hash);
  if (existing) {
    templateCacheHits++;
    // Refresh insertion order for simple LRU behavior
    normalizedTemplateCache.delete(hash);
    normalizedTemplateCache.set(hash, existing);
    return existing;
  }

  const buildPromise = (async (): Promise<NormalizedTemplateCacheEntry> => {
    const detected = detectMimeFromBytes(params.templateBytes);
    const mime =
      detected ||
      (params.declaredMime === "application/pdf" ||
      params.declaredMime === "image/png" ||
      params.declaredMime === "image/jpeg"
        ? params.declaredMime
        : null);

    if (!mime) {
      throw new Error("Unsupported certificate template format.");
    }

    if (mime === "application/pdf") {
      const srcDoc = await PDFDocument.load(params.templateBytes, {
        updateMetadata: false,
      });
      const totalPages = srcDoc.getPageCount();
      if (totalPages < 1) {
        throw new Error("Template PDF has no pages.");
      }
      const targetIdx =
        params.pageIndex >= 0 && params.pageIndex < totalPages
          ? Math.floor(params.pageIndex)
          : 0;

      // Build a minimal 1-page PDF containing only the selected page
      const singleDoc = await PDFDocument.create();
      const [copiedPage] = await singleDoc.copyPages(srcDoc, [targetIdx]);
      singleDoc.addPage(copiedPage);
      const { width, height } = copiedPage.getSize();
      const singlePagePdfBytes = await singleDoc.save();

      return {
        singlePagePdfBytes,
        pageWidthPt: Number(width.toFixed(2)),
        pageHeightPt: Number(height.toFixed(2)),
      };
    }

    // PNG or JPEG template -> embed once into a 1-page PDF and cache
    const imgDoc = await PDFDocument.create();
    const embeddedImage =
      mime === "image/png"
        ? await imgDoc.embedPng(params.templateBytes)
        : await imgDoc.embedJpg(params.templateBytes);

    const maxSide = Math.max(embeddedImage.width, embeddedImage.height);
    const scale = maxSide > 842 ? 842 / maxSide : 1;
    const pageWidthPt =
      params.hintWidthPt && params.hintWidthPt > 0
        ? Number(params.hintWidthPt.toFixed(2))
        : Number((embeddedImage.width * scale).toFixed(2));
    const pageHeightPt =
      params.hintHeightPt && params.hintHeightPt > 0
        ? Number(params.hintHeightPt.toFixed(2))
        : Number((embeddedImage.height * scale).toFixed(2));

    const page = imgDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt,
    });

    const singlePagePdfBytes = await imgDoc.save();
    return {
      singlePagePdfBytes,
      pageWidthPt,
      pageHeightPt,
    };
  })().catch((err) => {
    normalizedTemplateCache.delete(hash);
    throw err;
  });

  if (normalizedTemplateCache.size >= MAX_CACHED_TEMPLATES) {
    const oldestKey = normalizedTemplateCache.keys().next().value;
    if (oldestKey) normalizedTemplateCache.delete(oldestKey);
  }
  normalizedTemplateCache.set(hash, buildPromise);
  return buildPromise;
}

export function getCertificateCacheStats() {
  return {
    cachedFonts: fontBytesCache.size,
    cachedTemplates: normalizedTemplateCache.size,
    fontCacheHits,
    templateCacheHits,
  };
}

export function clearCertificateCaches() {
  fontBytesCache.clear();
  normalizedTemplateCache.clear();
  fontCacheHits = 0;
  templateCacheHits = 0;
}
