import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkEmbeddedFontGlyphs,
  generateCertificate,
  hexToRgbNormalized,
} from "@/lib/certificates";
import { NAME_STYLES, TEMPLATE_FILE, type CertType, type NameStyle } from "@/lib/config";

export { hexToRgbNormalized, checkEmbeddedFontGlyphs as checkServerFontGlyphSupport };

export interface RenderOverrides {
  nameY?: number;
  fontSize?: number;
  centerXRatio?: number;
}

/**
 * Legacy single-event compatibility wrapper delegating to `generateCertificate()`
 * in `@/lib/certificates`.
 */
export async function renderCertificate(
  certType: CertType,
  name: string,
  overrides: RenderOverrides = {},
): Promise<Uint8Array> {
  const style: NameStyle = {
    ...NAME_STYLES[certType],
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ),
  };

  const templateBytes = new Uint8Array(
    await readFile(path.join(process.cwd(), "public", TEMPLATE_FILE)),
  );

  const pageWidthPt = 843.75;
  const toHex = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c * 255)))
      .toString(16)
      .padStart(2, "0");
  const colorHex = `#${toHex(style.color[0])}${toHex(style.color[1])}${toHex(style.color[2])}`;

  return generateCertificate({
    templateBytes,
    fullName: name,
    config: {
      certificateType: {
        label: certType,
        template_mime: "application/pdf",
        page_index: style.pageIndex,
        name_x: Number((pageWidthPt * (style.centerXRatio ?? 0.665)).toFixed(2)),
        name_y: style.nameY,
        max_name_width: Number((pageWidthPt * (style.maxWidthRatio ?? 0.55)).toFixed(2)),
        name_font: style.fontFile,
        name_bold: true,
        name_size: style.fontSize,
        name_color: colorHex,
        name_align: "center",
      },
    },
  });
}
