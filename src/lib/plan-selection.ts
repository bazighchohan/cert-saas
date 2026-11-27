import type { PricedPlanPreset, PricingConfig } from "@/lib/pricing";

export const PLAN_SELECTION_COOKIE_NAME = "cert_plan_selection";
export const PLAN_SELECTION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

export interface SelectedPlanChoice {
  selectionType: "preset" | "custom";
  planId: string;
  events: number;
  certsPerEvent: number;
  months: number;
}

export function buildPlanSelectionQueryString(
  choice: SelectedPlanChoice,
): string {
  if (choice.selectionType === "preset" && choice.planId) {
    const params = new URLSearchParams({ plan: choice.planId });
    return params.toString();
  }
  const params = new URLSearchParams({
    plan: "custom",
    events: String(choice.events),
    certs: String(choice.certsPerEvent),
    months: String(choice.months),
  });
  return params.toString();
}

export function buildSignupHrefForPlan(choice: SelectedPlanChoice): string {
  return `/api/public/select-plan?${buildPlanSelectionQueryString(choice)}`;
}

export function buildDirectSignupQueryHref(choice: SelectedPlanChoice): string {
  return `/signup?${buildPlanSelectionQueryString(choice)}`;
}

/**
 * Parses and clamps a plan choice from URL query params against live `presets` + `pricingConfig`.
 */
export function parsePlanSelectionFromParams(
  query: {
    plan?: string | null;
    events?: string | number | null;
    certs?: string | number | null;
    months?: string | number | null;
  },
  pricingConfig: PricingConfig,
  presets: PricedPlanPreset[],
): SelectedPlanChoice | null {
  const rawPlan = String(query.plan ?? "")
    .trim()
    .toLowerCase();
  if (!rawPlan) return null;

  const matchedPreset = presets.find((p) => p.id === rawPlan);
  if (matchedPreset) {
    return {
      selectionType: "preset",
      planId: matchedPreset.id,
      events: matchedPreset.eventsCount,
      certsPerEvent: matchedPreset.certsPerEvent,
      months: matchedPreset.months,
    };
  }

  if (rawPlan === "custom") {
    const parsedEvents = Math.min(
      pricingConfig.maxEvents,
      Math.max(pricingConfig.minEvents, Math.round(Number(query.events) || 3)),
    );
    const rawCerts = Number(query.certs) || 100;
    const snappedCerts =
      Math.round(rawCerts / pricingConfig.certsStep) * pricingConfig.certsStep;
    const parsedCerts = Math.min(
      pricingConfig.maxCertsPerEvent,
      Math.max(pricingConfig.minCertsPerEvent, snappedCerts),
    );
    const rawMonths = Number(query.months) || 3;
    const parsedMonths = pricingConfig.allowedMonths.includes(rawMonths)
      ? rawMonths
      : (pricingConfig.allowedMonths[0] ?? 3);

    return {
      selectionType: "custom",
      planId: presets[0]?.id ?? "single-50",
      events: parsedEvents,
      certsPerEvent: parsedCerts,
      months: parsedMonths,
    };
  }

  return null;
}
