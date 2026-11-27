import { createHmac, timingSafeEqual } from "node:crypto";
import type { PricedPlanPreset, PricingConfig } from "@/lib/pricing";
import {
  buildDirectSignupQueryHref,
  buildPlanSelectionQueryString,
  buildSignupHrefForPlan,
  parsePlanSelectionFromParams,
  PLAN_SELECTION_COOKIE_MAX_AGE_SEC,
  PLAN_SELECTION_COOKIE_NAME,
  type SelectedPlanChoice,
} from "./plan-selection";

export {
  buildDirectSignupQueryHref,
  buildPlanSelectionQueryString,
  buildSignupHrefForPlan,
  parsePlanSelectionFromParams,
  PLAN_SELECTION_COOKIE_MAX_AGE_SEC,
  PLAN_SELECTION_COOKIE_NAME,
  type SelectedPlanChoice,
};

/**
 * Signs a plan choice with HMAC-SHA256 so the stored selection cookie cannot be forged.
 */
export function signPlanSelectionCookie(
  choice: SelectedPlanChoice,
  secret: string,
  nowMs = Date.now(),
): string {
  const payloadObj = {
    ...choice,
    exp: Math.floor(nowMs / 1000) + PLAN_SELECTION_COOKIE_MAX_AGE_SEC,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), "utf8").toString(
    "base64url",
  );
  const sigHex = createHmac("sha256", secret)
    .update(payloadB64, "utf8")
    .digest("hex");
  return `${payloadB64}.${sigHex}`;
}

export function verifyPlanSelectionCookie(
  cookieValue: string | null | undefined,
  secret: string,
  pricingConfig: PricingConfig,
  presets: PricedPlanPreset[],
  nowMs = Date.now(),
): SelectedPlanChoice | null {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = cookieValue.slice(0, dot);
  const sigHex = cookieValue.slice(dot + 1).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return null;

  const expectedHex = createHmac("sha256", secret)
    .update(payloadB64, "utf8")
    .digest("hex")
    .toLowerCase();

  const expectedBuf = Buffer.from(expectedHex, "hex");
  const receivedBuf = Buffer.from(sigHex, "hex");
  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return null;
  }

  try {
    const raw = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const exp = Number(raw.exp ?? 0);
    if (!Number.isFinite(exp) || exp < Math.floor(nowMs / 1000)) {
      return null;
    }

    if (raw.selectionType === "preset") {
      return parsePlanSelectionFromParams(
        { plan: String(raw.planId ?? "") },
        pricingConfig,
        presets,
      );
    }
    if (raw.selectionType === "custom") {
      return parsePlanSelectionFromParams(
        {
          plan: "custom",
          events: Number(raw.events),
          certs: Number(raw.certsPerEvent),
          months: Number(raw.months),
        },
        pricingConfig,
        presets,
      );
    }
    return null;
  } catch {
    return null;
  }
}
