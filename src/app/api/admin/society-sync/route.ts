import "server-only";
import { retiredLegacyEndpointResponse } from "@/lib/legacy-retired";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return retiredLegacyEndpointResponse();
}

export async function PUT() {
  return retiredLegacyEndpointResponse();
}
