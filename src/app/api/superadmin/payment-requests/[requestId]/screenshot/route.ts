import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentSuperAdmin } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/superadmin/payment-requests/[requestId]/screenshot
 * Streams payment proof screenshots exclusively to authenticated users listed
 * in `public.super_admins`.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const superAdmin = await getCurrentSuperAdmin();
  if (!superAdmin) {
    return NextResponse.json(
      { error: "Forbidden: super_admins membership required." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { requestId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: reqRow } = await admin
    .from("payment_requests")
    .select("id, screenshot_path")
    .eq("id", requestId)
    .maybeSingle();

  if (!reqRow || !reqRow.screenshot_path) {
    return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
  }

  const objectPath = String(reqRow.screenshot_path);
  const { data: blob, error } = await admin.storage
    .from("payment-proofs")
    .download(objectPath);

  if (error || !blob) {
    return NextResponse.json(
      { error: "Could not download receipt from Storage." },
      { status: 404 },
    );
  }

  const ext = objectPath.split(".").pop()?.toLowerCase() ?? "png";
  const contentType =
    ext === "pdf"
      ? "application/pdf"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : "image/png";

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="proof-${requestId.slice(0, 8)}.${ext}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
