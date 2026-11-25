import type { TemplateMimeType } from "@/lib/template-validator";

export type QrPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "custom";

/**
 * Positioning and style fields read directly from a `certificate_types` row
 * (supports both snake_case DB columns and camelCase mapped rows).
 */
export interface CertificateTypePositioningRow {
  label?: string | null;
  template_mime?: TemplateMimeType | string | null;
  templateMime?: TemplateMimeType | string | null;
  page_index?: number | null;
  pageIndex?: number | null;
  page_width_pt?: number | string | null;
  pageWidthPt?: number | null;
  page_height_pt?: number | string | null;
  pageHeightPt?: number | null;
  name_x?: number | string;
  nameX?: number;
  name_y?: number | string;
  nameY?: number;
  max_name_width?: number | string;
  maxNameWidth?: number;
  name_font?: string;
  nameFont?: string;
  name_bold?: boolean;
  nameBold?: boolean;
  name_size?: number | string;
  nameSize?: number;
  name_color?: string;
  nameColor?: string;
  name_align?: "left" | "center" | "right" | string;
  nameAlign?: "left" | "center" | "right";
}

export interface CertificateGenerationConfig {
  /** Row from `certificate_types` — source of all name positioning and typography. */
  certificateType: CertificateTypePositioningRow;
  /** Organization name embedded as PDF Author metadata. */
  orgName?: string | null;
  /** Event title embedded in PDF Title / Subject metadata. */
  eventTitle?: string | null;
  /** Controlled by `events.show_qr`: stamps a QR code + verify code when true and `verifyCode` is provided. */
  showQr?: boolean;
  /** Position for the QR verification stamp (default: 'bottom-right'). */
  qrPosition?: QrPosition;
  /** Custom X in PDF points from left when qrPosition === 'custom'. */
  qrXPt?: number | null;
  /** Custom Y in PDF points from bottom when qrPosition === 'custom'. */
  qrYPt?: number | null;
  /** QR code square size in PDF points (default: 54). */
  qrSizePt?: number;
  /** Base origin for verification links (e.g. "https://cert-saas.vercel.app"). Links to `{verifyBaseUrl}/verify/{code}`. */
  verifyBaseUrl?: string | null;
}

export interface GenerateCertificateInput {
  templateBytes: Uint8Array;
  config: CertificateGenerationConfig;
  fullName: string;
  verifyCode?: string | null;
}

export interface GenerateCertificateDetailedResult {
  pdfBytes: Uint8Array;
  pageWidthPt: number;
  pageHeightPt: number;
  effectiveFontSizePt: number;
  textWidthPt: number;
  textDrawXPt: number;
  baselineYPt: number;
  missingChars: string[];
  qrStamped: boolean;
}

export class CertificateValidationError extends Error {
  readonly code = "CERTIFICATE_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "CertificateValidationError";
  }
}
