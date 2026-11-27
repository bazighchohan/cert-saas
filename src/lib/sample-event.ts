import type { PublicEventInfo } from "@/lib/public-event";
import type { VerifiedCertificateSummary } from "@/lib/public-verify";

export const SAMPLE_EVENT_SLUG = "sample-event";
export const SAMPLE_ORG_ID = "00000000-0000-4000-8000-00000000de00";
export const SAMPLE_EVENT_ID = "00000000-0000-4000-8000-00000000de01";

export const SAMPLE_CERT_TYPE_PARTICIPATION_ID =
  "00000000-0000-4000-8000-00000000de11";
export const SAMPLE_CERT_TYPE_AWARD_ID =
  "00000000-0000-4000-8000-00000000de12";

export interface SampleAttendeeRecord {
  id: string;
  identifier: string;
  fullName: string;
  certificates: Array<{
    attendeeCertificateId: string;
    certificateTypeId: string;
    key: string;
    label: string;
    verifyCode: string;
    certificateTypeRow: Record<string, unknown>;
  }>;
}

export const SAMPLE_PUBLIC_EVENT: PublicEventInfo = {
  id: SAMPLE_EVENT_ID,
  orgId: SAMPLE_ORG_ID,
  orgName: "National University Computing Society",
  orgSlug: "nucs-demo",
  title: "Annual Tech & AI Symposium 2026 (Live Demo)",
  subtitle:
    "Try entering DEMO-001 or DEMO-002 below to preview and download a real QR-verified PDF certificate.",
  slug: SAMPLE_EVENT_SLUG,
  eventDate: "2026-11-15",
  contactEmail: "events@nucs-demo.edu.pk",
  contactPhone: "+92 300 1234567",
  released: true,
  retentionUntil: null,
  identifierLabel: "Registration ID",
  requireNameMatch: false,
  downloadLimit: null,
  showQr: true,
  qrPosition: "bottom-right",
  qrSizePt: 56,
};

export const SAMPLE_ATTENDEES: SampleAttendeeRecord[] = [
  {
    id: "00000000-0000-4000-8000-00000000da01",
    identifier: "DEMO-001",
    fullName: "Ayesha Khan",
    certificates: [
      {
        attendeeCertificateId: "00000000-0000-4000-8000-00000000dc01",
        certificateTypeId: SAMPLE_CERT_TYPE_PARTICIPATION_ID,
        key: "participation",
        label: "Certificate of Participation",
        verifyCode: "DEMOCERT2026",
        certificateTypeRow: {
          id: SAMPLE_CERT_TYPE_PARTICIPATION_ID,
          key: "participation",
          label: "Certificate of Participation",
          template_path: null,
          name_x: 421.88,
          name_y: 280,
          max_name_width: 480,
          name_font: "times",
          name_bold: true,
          name_size: 36,
          name_color: "#0B2A4F",
          name_align: "center",
          page_index: 0,
          page_width_pt: 841.89,
          page_height_pt: 595.28,
        },
      },
      {
        attendeeCertificateId: "00000000-0000-4000-8000-00000000dc02",
        certificateTypeId: SAMPLE_CERT_TYPE_AWARD_ID,
        key: "excellence-award",
        label: "Best Research Poster Award",
        verifyCode: "DEMOAWARD2026",
        certificateTypeRow: {
          id: SAMPLE_CERT_TYPE_AWARD_ID,
          key: "excellence-award",
          label: "Best Research Poster Award",
          template_path: null,
          name_x: 421.88,
          name_y: 280,
          max_name_width: 480,
          name_font: "helvetica",
          name_bold: true,
          name_size: 34,
          name_color: "#1E1B4B",
          name_align: "center",
          page_index: 0,
          page_width_pt: 841.89,
          page_height_pt: 595.28,
        },
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-00000000da02",
    identifier: "DEMO-002",
    fullName: "Bilal Ahmed",
    certificates: [
      {
        attendeeCertificateId: "00000000-0000-4000-8000-00000000dc03",
        certificateTypeId: SAMPLE_CERT_TYPE_PARTICIPATION_ID,
        key: "participation",
        label: "Certificate of Participation",
        verifyCode: "DEMOBILAL2026",
        certificateTypeRow: {
          id: SAMPLE_CERT_TYPE_PARTICIPATION_ID,
          key: "participation",
          label: "Certificate of Participation",
          template_path: null,
          name_x: 421.88,
          name_y: 280,
          max_name_width: 480,
          name_font: "times",
          name_bold: true,
          name_size: 36,
          name_color: "#0B2A4F",
          name_align: "center",
          page_index: 0,
          page_width_pt: 841.89,
          page_height_pt: 595.28,
        },
      },
    ],
  },
];

export function findSampleCertificateByVerifyCode(
  code: string,
): VerifiedCertificateSummary | null {
  const upper = code.trim().toUpperCase();
  for (const att of SAMPLE_ATTENDEES) {
    for (const cert of att.certificates) {
      if (cert.verifyCode === upper) {
        return {
          verifyCode: cert.verifyCode,
          recipientName: att.fullName,
          certificateLabel: cert.label,
          eventTitle: SAMPLE_PUBLIC_EVENT.title,
          eventSlug: SAMPLE_PUBLIC_EVENT.slug,
          eventDate: SAMPLE_PUBLIC_EVENT.eventDate,
          organizationName: SAMPLE_PUBLIC_EVENT.orgName,
          issuedAt: "2026-11-15T10:00:00.000Z",
        };
      }
    }
  }
  return null;
}
