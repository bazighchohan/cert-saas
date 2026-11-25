import { PDFName, PDFString, StandardFonts, rgb, type PDFDocument, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { QrPosition } from "./types";

export interface StampVerificationQrInput {
  pdf: PDFDocument;
  page: PDFPage;
  verifyCode: string;
  verifyBaseUrl?: string | null;
  position?: QrPosition;
  customXPt?: number | null;
  customYPt?: number | null;
  qrSizePt?: number;
}

/**
 * Stamps a crisp vector QR code + short human-readable verify code onto the
 * certificate page and attaches a clickable URI link annotation to `/verify/{code}`.
 * Uses merged horizontal module runs so the PDF stream stays tiny (~1 KB).
 */
export async function stampVerificationQr(
  input: StampVerificationQrInput,
): Promise<void> {
  const cleanCode = input.verifyCode.trim();
  if (!cleanCode) return;

  const base = (input.verifyBaseUrl ?? "").trim().replace(/\/+$/, "");
  const verifyUrl = base
    ? `${base}/verify/${encodeURIComponent(cleanCode)}`
    : `/verify/${encodeURIComponent(cleanCode)}`;

  const qr = QRCode.create(verifyUrl, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  if (moduleCount <= 0) return;

  const { width: pageW, height: pageH } = input.page.getSize();
  const qrSize = Math.max(28, Math.min(180, input.qrSizePt ?? 54));
  const margin = 26;
  const labelHeight = 11;
  const quietZone = 3.5;

  const pos: QrPosition = input.position ?? "bottom-right";
  let qrX: number;
  let qrY: number;

  if (pos === "custom" && input.customXPt != null && input.customYPt != null) {
    qrX = Math.max(4, Math.min(pageW - qrSize - 4, input.customXPt));
    qrY = Math.max(labelHeight + 4, Math.min(pageH - qrSize - 4, input.customYPt));
  } else if (pos === "bottom-left") {
    qrX = margin;
    qrY = margin + labelHeight;
  } else if (pos === "top-right") {
    qrX = pageW - margin - qrSize;
    qrY = pageH - margin - qrSize;
  } else if (pos === "top-left") {
    qrX = margin;
    qrY = pageH - margin - qrSize;
  } else {
    // bottom-right default
    qrX = pageW - margin - qrSize;
    qrY = margin + labelHeight;
  }

  // 1. White card behind QR + verify code so dark certificate borders never obscure scanning
  const cardX = qrX - quietZone;
  const cardY = qrY - labelHeight - 2;
  const cardW = qrSize + quietZone * 2;
  const cardH = qrSize + quietZone + labelHeight + 2;

  input.page.drawRectangle({
    x: cardX,
    y: cardY,
    width: cardW,
    height: cardH,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.84, 0.86, 0.9),
    borderWidth: 0.5,
  });

  // 2. Vector QR modules (merged per horizontal run to minimize PDF operators)
  const cell = qrSize / moduleCount;
  const dark = rgb(0.06, 0.1, 0.18);
  const data = qr.modules.data;

  for (let row = 0; row < moduleCount; row++) {
    // QR row 0 is top; PDF Y grows upward from bottom
    const moduleY = qrY + qrSize - (row + 1) * cell;
    let col = 0;
    while (col < moduleCount) {
      if (!data[row * moduleCount + col]) {
        col++;
        continue;
      }
      let runEnd = col + 1;
      while (runEnd < moduleCount && data[row * moduleCount + runEnd]) {
        runEnd++;
      }
      input.page.drawRectangle({
        x: qrX + col * cell,
        y: moduleY,
        width: (runEnd - col) * cell,
        height: cell,
        color: dark,
      });
      col = runEnd;
    }
  }

  // 3. Short verify code printed centered below the QR square
  const labelFont = await input.pdf.embedFont(StandardFonts.HelveticaBold);
  const codeText = cleanCode.slice(0, 16);
  const labelSize = 6.2;
  const textW = labelFont.widthOfTextAtSize(codeText, labelSize);
  const textX = qrX + (qrSize - textW) / 2;

  input.page.drawText(codeText, {
    x: textX,
    y: qrY - labelHeight + 2.5,
    size: labelSize,
    font: labelFont,
    color: rgb(0.2, 0.25, 0.33),
  });

  // 4. Clickable PDF Link annotation when a full http(s) verify URL is available
  if (/^https?:\/\//i.test(verifyUrl)) {
    const linkAnnotation = input.pdf.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [cardX, cardY, cardX + cardW, cardY + cardH],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(verifyUrl),
      },
    });
    const linkRef = input.pdf.context.register(linkAnnotation);
    input.page.node.addAnnot(linkRef);
    void PDFName;
  }
}
