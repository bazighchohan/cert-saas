import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RawAttendeeForAnalytics,
  RawDownloadLogEntry,
} from "@/lib/downloads-analytics";

/**
 * Loads all attendees (with their assigned certificate_types) and all download_log
 * rows for `(orgId, eventId)` in 1,000-row chunks so analytics and exports match
 * the database 100% accurately even on 5,000-row events.
 */
export async function fetchEventDownloadsDataset(params: {
  supabase: SupabaseClient;
  orgId: string;
  eventId: string;
}): Promise<{
  attendees: RawAttendeeForAnalytics[];
  downloadLogs: RawDownloadLogEntry[];
}> {
  const { supabase, orgId, eventId } = params;

  // 1. Load certificate types map for labels
  const { data: typesData } = await supabase
    .from("certificate_types")
    .select("id, label")
    .eq("org_id", orgId)
    .eq("event_id", eventId);

  const typeLabelMap = new Map<string, string>();
  for (const t of typesData ?? []) {
    typeLabelMap.set(t.id as string, (t.label as string) ?? "Certificate");
  }

  // 2. Load all attendees + attendee_certificates in 1,000-row pages
  const attendees: RawAttendeeForAnalytics[] = [];
  const certIdToTypeId = new Map<string, string>();

  let offset = 0;
  const CHUNK = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("attendees")
      .select(
        "*, attendee_certificates(id, certificate_type_id, download_count, verify_code, first_downloaded_at, last_downloaded_at)",
      )
      .eq("org_id", orgId)
      .eq("event_id", eventId)
      .order("identifier", { ascending: true })
      .range(offset, offset + CHUNK - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const raw of data) {
      const r = raw as Record<string, unknown>;
      const certArr = Array.isArray(r.attendee_certificates)
        ? (r.attendee_certificates as Array<Record<string, unknown>>)
        : [];

      const mappedCerts = certArr.map((c) => {
        const acId = c.id as string;
        const ctId = c.certificate_type_id as string;
        certIdToTypeId.set(acId, ctId);
        return {
          id: acId,
          certificateTypeId: ctId,
          certificateTypeLabel: typeLabelMap.get(ctId) ?? "Certificate",
          downloadCount: Number(c.download_count ?? 0),
          verifyCode: (c.verify_code as string) ?? "",
          firstDownloadedAt: (c.first_downloaded_at as string | null) ?? null,
          lastDownloadedAt: (c.last_downloaded_at as string | null) ?? null,
        };
      });

      attendees.push({
        id: r.id as string,
        identifier: r.identifier as string,
        fullName: r.full_name as string,
        email: (r.email as string | null) ?? null,
        source: ((r.source as string) === "manual" ? "manual" : "csv") as
          | "csv"
          | "manual",
        note: (r.note as string | null) ?? null,
        issueNote: (r.issue_note as string | null) ?? null,
        createdAt: r.created_at as string,
        certificates: mappedCerts,
      });
    }

    if (data.length < CHUNK) break;
    offset += CHUNK;
  }

  // 3. Load download_log rows belonging to this event's attendee_certificates
  const allEventCertIds = Array.from(certIdToTypeId.keys());
  const downloadLogs: RawDownloadLogEntry[] = [];

  for (let i = 0; i < allEventCertIds.length; i += 400) {
    const idSlice = allEventCertIds.slice(i, i + 400);
    const { data: logsBatch, error: logErr } = await supabase
      .from("download_log")
      .select("id, attendee_certificate_id, downloaded_at, ip_hash")
      .eq("org_id", orgId)
      .in("attendee_certificate_id", idSlice)
      .order("downloaded_at", { ascending: true });

    if (logErr) throw logErr;
    for (const l of logsBatch ?? []) {
      const acId = l.attendee_certificate_id as string;
      downloadLogs.push({
        id: l.id as number | string,
        attendeeCertificateId: acId,
        certificateTypeId: certIdToTypeId.get(acId) ?? "",
        downloadedAt: l.downloaded_at as string,
        ipHash: (l.ip_hash as string | null) ?? null,
      });
    }
  }

  return { attendees, downloadLogs };
}
