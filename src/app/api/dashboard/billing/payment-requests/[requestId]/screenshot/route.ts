import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * GET /api/dashboard/billing/payment-requests/[requestId]/screenshot
 * Streams the payment receipt image/PDF from the private `payment-proofs` bucket.
 * Strictly restricted to members of the owning active organization OR users in `public.super_admins`.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ org }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    isUserInSuperAdminsTable(user.id),
  ]);

  const { requestId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: reqRow } = await admin
    .from("payment_requests")
    .select("id, org_id, screenshot_path")
    .eq("id", requestId)
    .maybeSingle();

  if (!reqRow || !reqRow.screenshot_path) {
    return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
  }

  const canView =
    isSuperAdmin ||
    (Boolean(org) && org!.status === "active" && reqRow.org_id === org!.id);
  if (!canView) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const path = String(reqRow.screenshot_path);
  const { data: blob, error } = await admin.storage
    .from("payment-proofs")
    .download(path);

  if (error || !blob) {
    return NextResponse.json(
      { error: "Could not download payment receipt from Storage." },
      { status: 404 },
    );
  }

  const ext = path.split(".").pop()?.toLowerCase() ?? "png";
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
      "Content-Disposition": `inline; filename="payment-proof-${requestId.slice(0, 8)}.${ext}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
