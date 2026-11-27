import "server-only";

import {
  attachPricesToPresets,
  DEFAULT_PLAN_PRESETS,
  DEFAULT_PRICING_CONFIG,
  parsePricingConfigRow,
  type PackageKind,
  type PlanPreset,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * Reads the live `public.pricing_config` row from Supabase on every request
 * (no module-level caching) so editing a value in `pricing_config` immediately
 * updates every computed price on the landing page, billing page, and server
 * without redeploying.
 */
export async function getPricingConfig(): Promise<PricingConfig> {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("pricing_config")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    if (error || !data) {
      return { ...DEFAULT_PRICING_CONFIG };
    }
    return parsePricingConfigRow(data as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_PRICING_CONFIG };
  }
}

function mapPresetRow(row: Record<string, unknown>, idx: number): PlanPreset | null {
  const id = String(row.id ?? "").trim();
  if (!id || id === "free" || id === "starter") return null;

  const rawKind = String(row.kind ?? "single");
  const kind: PackageKind = (["single", "multi", "pro", "custom"] as const).includes(
    rawKind as PackageKind,
  )
    ? (rawKind as PackageKind)
    : id.startsWith("multi")
      ? "multi"
      : id.startsWith("pro")
        ? "pro"
        : "single";

  const eventsCount = Number(row.events_count ?? (kind === "pro" ? 10 : kind === "multi" ? 3 : 1));
  const certsPerEvent = Number(row.certs_per_event ?? 100);
  const months = Number(row.months ?? (kind === "pro" ? 12 : 3));

  if (
    !Number.isInteger(eventsCount) ||
    eventsCount < 1 ||
    !Number.isInteger(certsPerEvent) ||
    certsPerEvent < 25
  ) {
    return null;
  }

  return {
    id,
    name: String(row.name ?? id),
    kind,
    eventsCount,
    certsPerEvent,
    months: [3, 6, 12].includes(months) ? months : 3,
    allowCustomBranding:
      row.allow_custom_branding === undefined
        ? true
        : Boolean(row.allow_custom_branding),
    sortOrder:
      row.sort_order !== undefined && row.sort_order !== null
        ? Number(row.sort_order)
        : idx + 1,
  };
}

/**
 * Loads active preset plans from `public.plans` and computes their live PKR
 * prices using `computePrice(..., pricingConfig)`.
 */
export async function getPricingAndPresets(): Promise<{
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
}> {
  const pricingConfig = await getPricingConfig();

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("plans")
      .select("*")
      .eq("active", true)
      .order("sort_order", { ascending: true });

    if (!error && Array.isArray(data) && data.length > 0) {
      const mapped = data
        .map((r, i) => mapPresetRow(r as Record<string, unknown>, i))
        .filter((p): p is PlanPreset => p !== null);

      if (mapped.length > 0) {
        return {
          pricingConfig,
          presets: attachPricesToPresets(mapped, pricingConfig),
        };
      }
    }
  } catch {
    // Fallback to DEFAULT_PLAN_PRESETS if DB is unreachable or migration 013 not yet run
  }

  return {
    pricingConfig,
    presets: attachPricesToPresets(DEFAULT_PLAN_PRESETS, pricingConfig),
  };
}
