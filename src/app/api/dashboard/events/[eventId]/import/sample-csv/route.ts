import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildSampleImportCsv } from "@/lib/tabular-import";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  const user = await getCurrentUser();
  const org = await getCurrentOrg();
  if (!user || !org) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const [eventRes, typesRes] = await Promise.all([
    supabase
      .from("events")
      .select("id, slug, identifier_label")
      .eq("id", eventId)
      .eq("org_id", org.id)
      .maybeSingle(),
    supabase
      .from("certificate_types")
      .select("id, key, label")
      .eq("org_id", org.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: true }),
  ]);

  if (!eventRes.data) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const csvBody =
    "\uFEFF" +
    buildSampleImportCsv(
      (eventRes.data.identifier_label as string) ?? "Registration number",
      (typesRes.data ?? []).map((t) => ({
        id: t.id as string,
        key: t.key as string,
        label: t.label as string,
      })),
    );

  const safeSlug = (eventRes.data.slug as string) || "event";
  return new NextResponse(csvBody, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sample-attendees-${safeSlug}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
