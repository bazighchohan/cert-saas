import "server-only";

import { createHmac } from "node:crypto";
import type { QrPosition } from "@/lib/certificates";
import {
  buildSafeCertificateFilename,
  escapeIlikeExact,
  GENERIC_LOOKUP_ERROR,
  normalizeForLookup,
  signLookupTokenWithSecret,
  verifyLookupTokenWithSecret,
  type LookupTokenPayload,
} from "@/lib/public-event-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

export {
  buildSafeCertificateFilename,
  escapeIlikeExact,
  GENERIC_LOOKUP_ERROR,
  normalizeForLookup,
  type LookupTokenPayload,
};

export interface PublicEventInfo {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  title: string;
  subtitle: string | null;
  slug: string;
  eventDate: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  released: boolean;
  retentionUntil: string | null;
  identifierLabel: string;
  requireNameMatch: boolean;
  downloadLimit: number | null;
  showQr: boolean;
  qrPosition: QrPosition;
  qrSizePt: number;
}

function getSigningSecret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set on the server.");
  }
  return key;
}

/**
 * Hashes client IP with a server secret so raw IP addresses are never stored in download_log.
 */
export function hashClientIp(ip: string): string {
  return createHmac("sha256", getSigningSecret())
    .update(`ip:${ip}`)
    .digest("hex")
    .slice(0, 32);
}

export function createPublicLookupToken(
  payload: Omit<LookupTokenPayload, "exp">,
): string {
  return signLookupTokenWithSecret(payload, getSigningSecret());
}

export function verifyPublicLookupToken(
  token: string | null | undefined,
): LookupTokenPayload | null {
  return verifyLookupTokenWithSecret(token, getSigningSecret());
}

export type PublicEventPageState =
  | { state: "not_found" }
  | { state: "unavailable"; title: string; orgName: string }
  | {
      state: "expired";
      title: string;
      orgName: string;
      retentionUntil: string;
      contactEmail: string | null;
      contactPhone: string | null;
    }
  | { state: "ok"; event: PublicEventInfo };

/**
 * Resolves the public `/e/[slug]` state:
 * - `not_found`: slug does not exist
 * - `unavailable`: issuing organization is suspended
 * - `expired`: event was released and `retention_until <= now()` ("this event has expired")
 * - `ok`: event active (even if the organization's purchase has expired — public
 *   downloads keep working until `retention_until`!)
 */
export async function getPublicEventPageState(
  rawSlug: string,
): Promise<PublicEventPageState> {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return { state: "not_found" };
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("events")
    .select("*, organizations!inner(id, name, slug, status)")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) {
    return { state: "not_found" };
  }

  const row = data as Record<string, unknown>;
  const orgRel = Array.isArray(row.organizations)
    ? (row.organizations[0] as Record<string, unknown> | undefined)
    : (row.organizations as Record<string, unknown> | undefined);

  if (!orgRel) {
    return { state: "not_found" };
  }

  if (orgRel.status !== "active") {
    return {
      state: "unavailable",
      title: String(row.title ?? "Event"),
      orgName: String(orgRel.name ?? "Organization"),
    };
  }

  const released = Boolean(row.released);
  const retentionUntil =
    typeof row.retention_until === "string" ? row.retention_until : null;
  const contactEmail = (row.contact_email as string | null) ?? null;
  const contactPhone = (row.contact_phone as string | null) ?? null;

  if (
    released &&
    retentionUntil &&
    !Number.isNaN(Date.parse(retentionUntil)) &&
    Date.parse(retentionUntil) <= Date.now()
  ) {
    return {
      state: "expired",
      title: String(row.title ?? "Event"),
      orgName: String(orgRel.name ?? "Organization"),
      retentionUntil,
      contactEmail,
      contactPhone,
    };
  }

  const qrPosRaw = String(row.qr_position ?? "bottom-right");
  const qrPosition: QrPosition = [
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
    "custom",
  ].includes(qrPosRaw)
    ? (qrPosRaw as QrPosition)
    : "bottom-right";

  return {
    state: "ok",
    event: {
      id: row.id as string,
      orgId: orgRel.id as string,
      orgName: orgRel.name as string,
      orgSlug: orgRel.slug as string,
      title: row.title as string,
      subtitle: (row.subtitle as string | null) ?? null,
      slug: row.slug as string,
      eventDate: (row.event_date as string | null) ?? null,
      contactEmail,
      contactPhone,
      released,
      retentionUntil,
      identifierLabel:
        (row.identifier_label as string) ?? "Registration number",
      requireNameMatch: Boolean(row.require_name_match),
      downloadLimit:
        row.download_limit === null || row.download_limit === undefined
          ? null
          : Number(row.download_limit),
      showQr: Boolean(row.show_qr ?? false),
      qrPosition,
      qrSizePt:
        row.qr_size !== null && row.qr_size !== undefined
          ? Number(row.qr_size)
          : 54,
    },
  };
}

export async function getPublicEventBySlug(
  rawSlug: string,
): Promise<PublicEventInfo | null> {
  const res = await getPublicEventPageState(rawSlug);
  return res.state === "ok" ? res.event : null;
}
