import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (err) {
    console.error("Failed to sign out:", err);
  }
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
