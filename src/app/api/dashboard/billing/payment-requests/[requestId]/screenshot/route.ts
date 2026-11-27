import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { UuidSchema } from "@/lib/schemas";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

async function findReceiptRowById(requestId: string): Promise<{
  id: string;
  org_id: string;
  screenshot_path: string | null;
} | null> {
  const admin = getSupabaseAdmin();

  const [purchaseRes, topupRes, legacyRes] = await Promise.all([
    admin
      .from("purchases")
      .select("id, org_id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
    admin
      .from("certificate_topups")
      .select("id, org_id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
    admin
      .from("payment_requests")
      .select("id, org_id, screenshot_path")
      .eq("id", requestId)
      .maybeSingle(),
  ]);

  const row = purchaseRes.data ?? topupRes.data ?? legacyRes.data;
  if (!row) return null;
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    screenshot_path:
      typeof row.screenshot_path === "string" ? row.screenshot_path : null,
  };
}

/**
 * GET /api/dashboard/billing/payment-requests/[requestId]/screenshot
 * Streams payment proof receipts for `purchases`, `certificate_topups`, or
 * legacy `payment_requests` strictly scoped to owning org members or `super_admins`.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ org }, isSuperAdmin, { requestId: rawId }] = await Promise.all([
    getCurrentOrgResult(),
    isUserInSuperAdminsTable(user.id),
    context.params,
  ]);

  const parsedId = UuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
  }

  const reqRow = await findReceiptRowById(parsedId.data);
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
  const admin = getSupabaseAdmin();
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
      "Content-Disposition": `inline; filename="payment-proof-${parsedId.data.slice(0, 8)}.${ext}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
