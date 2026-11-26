import "server-only";

import { NextResponse } from "next/server";

/**
 * Returns HTTP 410 Gone for retired single-event endpoints that pre-dated
 * multi-tenant `org_id` + `event_id` isolation.
 */
export function retiredLegacyEndpointResponse() {
  return NextResponse.json(
    {
      error:
        "This legacy single-event endpoint has been retired for multi-tenant security isolation. Use /dashboard/events/[eventId] or /e/[slug].",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
