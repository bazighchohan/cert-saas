import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { QrPosition } from "@/lib/certificates";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * Single generic error message for all lookup failures so attackers cannot
 * enumerate registered identifiers or names.
 */
export const GENERIC_LOOKUP_ERROR =
  "We couldn’t find a matching certificate record. Please double-check your details and try again.";

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
  identifierLabel: string;
  requireNameMatch: boolean;
  downloadLimit: number | null;
  showQr: boolean;
  qrPosition: QrPosition;
  qrSizePt: number;
}

/**
 * Case- and space-insensitive normalization for attendee identifier & name matching.
 */
export function normalizeForLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function escapeIlikeExact(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
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

export interface LookupTokenPayload {
  orgId: string;
  eventId: string;
  slug: string;
  attendeeId: string;
  identifierLower: string;
  exp: number;
}

const LOOKUP_TOKEN_TTL_MS = 20 * 60 * 1000; // 20 minutes

export function createPublicLookupToken(
  payload: Omit<LookupTokenPayload, "exp">,
): string {
  const full: LookupTokenPayload = {
    ...payload,
    exp: Date.now() + LOOKUP_TOKEN_TTL_MS,
  };
  const bodyB64 = Buffer.from(JSON.stringify(full), "utf8").toString(
    "base64url",
  );
  const sigB64 = createHmac("sha256", getSigningSecret())
    .update(bodyB64)
    .digest("base64url");
  return `${bodyB64}.${sigB64}`;
}

export function verifyPublicLookupToken(
  token: string | null | undefined,
): LookupTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = createHmac("sha256", getSigningSecret())
    .update(bodyB64)
    .digest("base64url");

  const a = Buffer.from(sigB64, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(bodyB64, "base64url").toString("utf8"),
    ) as LookupTokenPayload;
    if (!parsed.exp || parsed.exp <= Date.now()) return null;
    if (
      !parsed.orgId ||
      !parsed.eventId ||
      !parsed.slug ||
      !parsed.attendeeId ||
      !parsed.identifierLower
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fetches public event metadata + active organization name by event slug.
 * Returns null if the event does not exist or its organization is suspended.
 */
export async function getPublicEventBySlug(
  rawSlug: string,
): Promise<PublicEventInfo | null> {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return null;
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("events")
    .select("*, organizations!inner(id, name, slug, status)")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  const orgRel = Array.isArray(row.organizations)
    ? (row.organizations[0] as Record<string, unknown> | undefined)
    : (row.organizations as Record<string, unknown> | undefined);

  if (!orgRel || orgRel.status !== "active") {
    return null;
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
    id: row.id as string,
    orgId: orgRel.id as string,
    orgName: orgRel.name as string,
    orgSlug: orgRel.slug as string,
    title: row.title as string,
    subtitle: (row.subtitle as string | null) ?? null,
    slug: row.slug as string,
    eventDate: (row.event_date as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    released: Boolean(row.released),
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
  };
}

/**
 * Builds a header-safe PDF attachment filename.
 */
export function buildSafeCertificateFilename(
  eventSlug: string,
  certKey: string,
  identifier: string,
): string {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "cert";

  return `certificate-${clean(eventSlug)}-${clean(certKey)}-${clean(identifier)}.pdf`;
}
