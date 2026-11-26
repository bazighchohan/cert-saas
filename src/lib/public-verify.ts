import "server-only";

import { VerifyCodeSchema } from "@/lib/schemas";
import { getSupabaseAdmin } from "@/lib/supabase";

export interface VerifiedCertificateSummary {
  verifyCode: string;
  recipientName: string;
  certificateLabel: string;
  eventTitle: string;
  eventSlug: string;
  eventDate: string | null;
  organizationName: string;
  issuedAt: string;
}

export type VerifyLookupResult =
  | { status: "valid"; certificate: VerifiedCertificateSummary }
  | { status: "unavailable" }
  | { status: "not_found" };

/**
 * Verifies a public certificate `verify_code` without exposing any internal
 * UUIDs, student identifiers, or email addresses.
 * Rejects suspended organizations and unreleased events.
 */
export async function lookupCertificateByVerifyCode(
  rawCode: string,
): Promise<VerifyLookupResult> {
  const parsed = VerifyCodeSchema.safeParse(rawCode);
  if (!parsed.success) {
    return { status: "not_found" };
  }

  const code = parsed.data;
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("attendee_certificates")
    .select(
      "verify_code, created_at, attendees!inner(full_name), certificate_types!inner(label), events!inner(title, slug, event_date, released, organizations!inner(name, status))",
    )
    .eq("verify_code", code)
    .maybeSingle();

  if (error || !data) {
    return { status: "not_found" };
  }

  const row = data as Record<string, unknown>;
  const att = (
    Array.isArray(row.attendees) ? row.attendees[0] : row.attendees
  ) as Record<string, unknown> | undefined;
  const ct = (
    Array.isArray(row.certificate_types)
      ? row.certificate_types[0]
      : row.certificate_types
  ) as Record<string, unknown> | undefined;
  const ev = (
    Array.isArray(row.events) ? row.events[0] : row.events
  ) as Record<string, unknown> | undefined;
  const org = (
    ev && Array.isArray(ev.organizations)
      ? ev.organizations[0]
      : ev?.organizations
  ) as Record<string, unknown> | undefined;

  if (!att || !ct || !ev || !org) {
    return { status: "not_found" };
  }

  if (org.status !== "active") {
    return { status: "unavailable" };
  }

  if (!ev.released) {
    return { status: "not_found" };
  }

  return {
    status: "valid",
    certificate: {
      verifyCode: String(row.verify_code),
      recipientName: String(att.full_name ?? ""),
      certificateLabel: String(ct.label ?? "Certificate"),
      eventTitle: String(ev.title ?? ""),
      eventSlug: String(ev.slug ?? ""),
      eventDate: typeof ev.event_date === "string" ? ev.event_date : null,
      organizationName: String(org.name ?? ""),
      issuedAt: String(row.created_at ?? ""),
    },
  };
}
