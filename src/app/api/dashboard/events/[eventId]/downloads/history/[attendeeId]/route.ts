import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AttendeeDownloadHistoryItem {
  id: string;
  certificateTypeLabel: string;
  verifyCode: string;
  downloadedAt: string;
  ipFingerprint: string | null;
}

/**
 * GET /api/dashboard/events/[eventId]/downloads/history/[attendeeId]
 * Returns per-attendee download history from `download_log`, strictly scoped
 * via getCurrentOrg() + eventId + attendeeId.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ eventId: string; attendeeId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId, attendeeId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { data: certs, error: certsErr } = await supabase
    .from("attendee_certificates")
    .select(
      "id, verify_code, certificate_types!inner(label)",
    )
    .eq("org_id", org.id)
    .eq("event_id", eventId)
    .eq("attendee_id", attendeeId);

  if (certsErr) {
    return NextResponse.json({ error: certsErr.message }, { status: 500 });
  }

  if (!certs || certs.length === 0) {
    return NextResponse.json({ history: [] });
  }

  const metaByCertId = new Map<
    string,
    { label: string; verifyCode: string }
  >();
  for (const c of certs) {
    const ct = Array.isArray(c.certificate_types)
      ? (c.certificate_types[0] as Record<string, unknown>)
      : (c.certificate_types as Record<string, unknown>);
    metaByCertId.set(c.id as string, {
      label: (ct?.label as string) ?? "Certificate",
      verifyCode: (c.verify_code as string) ?? "",
    });
  }

  const { data: logs, error: logsErr } = await supabase
    .from("download_log")
    .select("id, attendee_certificate_id, downloaded_at, ip_hash")
    .eq("org_id", org.id)
    .in("attendee_certificate_id", Array.from(metaByCertId.keys()))
    .order("downloaded_at", { ascending: false });

  if (logsErr) {
    return NextResponse.json({ error: logsErr.message }, { status: 500 });
  }

  const history: AttendeeDownloadHistoryItem[] = (logs ?? []).map((l) => {
    const meta = metaByCertId.get(l.attendee_certificate_id as string);
    const rawHash = (l.ip_hash as string | null) ?? null;
    return {
      id: String(l.id),
      certificateTypeLabel: meta?.label ?? "Certificate",
      verifyCode: meta?.verifyCode ?? "",
      downloadedAt: l.downloaded_at as string,
      ipFingerprint: rawHash ? rawHash.slice(0, 10) : null,
    };
  });

  return NextResponse.json(
    { history },
    { headers: { "Cache-Control": "no-store" } },
  );
}
