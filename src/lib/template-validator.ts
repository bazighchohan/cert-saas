import "server-only";

import { PDFDocument } from "pdf-lib";

export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024; // 5 MB

export type TemplateMimeType =
  | "application/pdf"
  | "image/png"
  | "image/jpeg";

export interface TemplateInspectionResult {
  valid: boolean;
  error?: string;
  mimeType?: TemplateMimeType;
  extension?: "pdf" | "png" | "jpg";
  pageCount?: number;
  pageIndex?: number;
  pageWidthPt?: number;
  pageHeightPt?: number;
}

/**
 * Detects file format strictly from magic bytes at the start of the buffer.
 */
export function detectMagicMime(bytes: Uint8Array): TemplateMimeType | null {
  if (bytes.length < 8) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PDF: "%PDF-" (25 50 44 46 2D) at offset 0
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
 * Converts image pixel dimensions to standard PDF points (longest side normalized
 * to 842 pt — A4 landscape width — if larger than 842 px, preserving exact aspect ratio).
 */
function imagePixelsToPoints(
  widthPx: number,
  heightPx: number,
): { widthPt: number; heightPt: number } {
  const maxSide = Math.max(widthPx, heightPx);
  const scale = maxSide > 842 ? 842 / maxSide : 1;
  return {
    widthPt: Number((widthPx * scale).toFixed(2)),
    heightPt: Number((heightPx * scale).toFixed(2)),
  };
}

/**
 * Checks whether raw PDF bytes contain an /Encrypt dictionary entry outside comments.
 */
function hasPdfEncryptDictionary(bytes: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(bytes);
  return /\/Encrypt\b/.test(text);
}

/**
 * Server-side template validator:
 * 1. Enforces max 5 MB size.
 * 2. Verifies magic bytes match PDF, PNG, or JPG (and match declared MIME if provided).
 * 3. Rejects password-protected / encrypted PDFs.
 * 4. Extracts page count and selected page dimensions in points (pageWidthPt, pageHeightPt).
 */
export async function validateAndInspectTemplate(
  bytes: Uint8Array,
  declaredMime?: string | null,
  requestedPageIndex = 0,
): Promise<TemplateInspectionResult> {
  if (!bytes || bytes.byteLength === 0) {
    return { valid: false, error: "Uploaded file is empty." };
  }

  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    return {
      valid: false,
      error: "File exceeds the 5 MB maximum size limit.",
    };
  }

  const detectedMime = detectMagicMime(bytes);
  if (!detectedMime) {
    return {
      valid: false,
      error:
        "Unsupported file format. Only valid PDF, PNG, and JPG files are accepted.",
    };
  }

  // If the client declared a specific MIME type (not empty / application/octet-stream),
  // require it to match the magic bytes so spoofed extensions are rejected.
  const normalizedDeclared = declaredMime?.trim().toLowerCase();
  if (
    normalizedDeclared &&
    normalizedDeclared !== "application/octet-stream" &&
    !(normalizedDeclared === "image/jpg" && detectedMime === "image/jpeg") &&
    normalizedDeclared !== detectedMime
  ) {
    return {
      valid: false,
      error: `File content (${detectedMime}) does not match declared file type (${normalizedDeclared}).`,
    };
  }

  if (detectedMime === "application/pdf") {
    if (hasPdfEncryptDictionary(bytes)) {
      return {
        valid: false,
        error:
          "Password-protected or encrypted PDFs are not supported. Please upload an unlocked PDF.",
      };
    }

    let pdfDoc: PDFDocument;
    try {
      pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/encrypt|password/i.test(msg)) {
        return {
          valid: false,
          error:
            "Password-protected or encrypted PDFs are not supported. Please upload an unlocked PDF.",
        };
      }
      return {
        valid: false,
        error: "Invalid or corrupted PDF file.",
      };
    }

    if (pdfDoc.isEncrypted) {
      return {
        valid: false,
        error:
          "Password-protected or encrypted PDFs are not supported. Please upload an unlocked PDF.",
      };
    }

    const pageCount = pdfDoc.getPageCount();
    if (pageCount < 1) {
      return { valid: false, error: "PDF has no pages." };
    }

    const pageIndex = Math.max(0, Math.floor(requestedPageIndex));
    if (pageIndex >= pageCount) {
      return {
        valid: false,
        error: `Selected page ${pageIndex + 1} exceeds PDF page count (${pageCount}).`,
      };
    }

    const page = pdfDoc.getPage(pageIndex);
    const { width, height } = page.getSize();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { valid: false, error: "Could not read PDF page dimensions." };
    }

    return {
      valid: true,
      mimeType: "application/pdf",
      extension: "pdf",
      pageCount,
      pageIndex,
      pageWidthPt: Number(width.toFixed(2)),
      pageHeightPt: Number(height.toFixed(2)),
    };
  }

  // PNG or JPEG: embed into a fresh PDFDocument to verify image integrity and get dimensions.
  try {
    const doc = await PDFDocument.create();
    const embedded =
      detectedMime === "image/png"
        ? await doc.embedPng(bytes)
        : await doc.embedJpg(bytes);

    if (embedded.width <= 0 || embedded.height <= 0) {
      return { valid: false, error: "Could not read image dimensions." };
    }

    const { widthPt, heightPt } = imagePixelsToPoints(
      embedded.width,
      embedded.height,
    );

    return {
      valid: true,
      mimeType: detectedMime,
      extension: detectedMime === "image/png" ? "png" : "jpg",
      pageCount: 1,
      pageIndex: 0,
      pageWidthPt: widthPt,
      pageHeightPt: heightPt,
    };
  } catch {
    return {
      valid: false,
      error: `Invalid or corrupted ${
        detectedMime === "image/png" ? "PNG" : "JPG"
      } image.`,
    };
  }
}
