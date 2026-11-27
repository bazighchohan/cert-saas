import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { UuidSchema } from "@/lib/schemas";
import { getCurrentSuperAdmin } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/superadmin/payment-requests/[requestId]/screenshot
 * Streams payment proof screenshots for `purchases`, `certificate_topups`, or
 * `payment_requests` exclusively to authenticated users in `public.super_admins`.
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

  const { requestId: rawId } = await context.params;
  const parsedId = UuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
  }
  const requestId = parsedId.data;

  const admin = getSupabaseAdmin();
  const [purchaseRes, topupRes, legacyRes] = await Promise.all([
    admin
      .from("purchases")
      .select("id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
    admin
      .from("certificate_topups")
      .select("id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
    admin
      .from("payment_requests")
      .select("id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
  ]);

  const reqRow = purchaseRes.data ?? topupRes.data ?? legacyRes.data;
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
