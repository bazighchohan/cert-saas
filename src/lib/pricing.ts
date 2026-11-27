export type PackageKind = "single" | "multi" | "pro" | "custom";
export type AllowedDurationMonths = 3 | 6 | 12;

export interface VolumeDiscountTier {
  min_events: number;
  discount: number; // 0..1 (e.g. 0.2 = 20% off)
}

export interface DurationMultiplierTier {
  months: number;
  mult: number; // e.g. 1.0, 1.05, 1.1
}

export interface PricingConfig {
  eventFeePkr: number;
  certRatePkr: number;
  volumeDiscounts: VolumeDiscountTier[];
  durationMultipliers: DurationMultiplierTier[];
  roundingPkr: number;
  minEvents: number;
  maxEvents: number;
  minCertsPerEvent: number;
  maxCertsPerEvent: number;
  certsStep: number;
  allowedMonths: number[];
  updatedAt?: string | null;
}

export interface ComputePriceInput {
  events: number;
  certsPerEvent: number;
  months?: number;
}

export interface ComputedPriceBreakdown {
  events: number;
  certsPerEvent: number;
  months: number;
  totalCertificatesCapacity: number;
  perEventPricePkr: number;
  undiscountedSubtotalPkr: number;
  discountRate: number;
  discountPercent: number;
  discountedSubtotalPkr: number;
  durationMultiplier: number;
  rawTotalPkr: number;
  listPricePkr: number;
  discountPkr: number;
  finalPricePkr: number;
  totalPkr: number;
}

export interface PlanPreset {
  id: string;
  name: string;
  kind: PackageKind;
  eventsCount: number;
  certsPerEvent: number;
  months: number;
  allowCustomBranding: boolean;
  sortOrder: number;
}

export interface PricedPlanPreset extends PlanPreset {
  pricing: ComputedPriceBreakdown;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  eventFeePkr: 500,
  certRatePkr: 5,
  volumeDiscounts: [
    { min_events: 1, discount: 0 },
    { min_events: 2, discount: 0.2 },
    { min_events: 4, discount: 0.35 },
    { min_events: 7, discount: 0.5 },
  ],
  durationMultipliers: [
    { months: 3, mult: 1.0 },
    { months: 6, mult: 1.05 },
    { months: 12, mult: 1.1 },
  ],
  roundingPkr: 50,
  minEvents: 1,
  maxEvents: 20,
  minCertsPerEvent: 25,
  maxCertsPerEvent: 500,
  certsStep: 25,
  allowedMonths: [3, 6, 12],
  updatedAt: null,
};

export const DEFAULT_PLAN_PRESETS: PlanPreset[] = [
  {
    id: "single-50",
    name: "Single (50 certs)",
    kind: "single",
    eventsCount: 1,
    certsPerEvent: 50,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 1,
  },
  {
    id: "single-100",
    name: "Single (100 certs)",
    kind: "single",
    eventsCount: 1,
    certsPerEvent: 100,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 2,
  },
  {
    id: "multi-50",
    name: "Multi (3 × 50 certs)",
    kind: "multi",
    eventsCount: 3,
    certsPerEvent: 50,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 3,
  },
  {
    id: "multi-100",
    name: "Multi (3 × 100 certs)",
    kind: "multi",
    eventsCount: 3,
    certsPerEvent: 100,
    months: 3,
    allowCustomBranding: true,
    sortOrder: 4,
  },
  {
    id: "pro",
    name: "Pro (10 × 100 certs)",
    kind: "pro",
    eventsCount: 10,
    certsPerEvent: 100,
    months: 12,
    allowCustomBranding: true,
    sortOrder: 5,
  },
];

function roundToIncrement(value: number, roundingPkr: number): number {
  const step = roundingPkr > 0 ? roundingPkr : 1;
  return Math.round(value / step) * step;
}

/**
 * Parses a raw database row from `public.pricing_config` into a strongly-typed
 * `PricingConfig`, safely falling back to defaults if any column is missing.
 */
export function parsePricingConfigRow(
  raw: Record<string, unknown> | null | undefined,
): PricingConfig {
  if (!raw) return { ...DEFAULT_PRICING_CONFIG };

  const rawDiscounts = Array.isArray(raw.volume_discounts)
    ? raw.volume_discounts
    : DEFAULT_PRICING_CONFIG.volumeDiscounts;
  const volumeDiscounts: VolumeDiscountTier[] = rawDiscounts
    .map((item) => {
      const r = item as Record<string, unknown>;
      return {
        min_events: Math.max(1, Math.floor(Number(r.min_events ?? 1))),
        discount: Math.min(0.95, Math.max(0, Number(r.discount ?? 0))),
      };
    })
    .filter((d) => Number.isFinite(d.min_events) && Number.isFinite(d.discount))
    .sort((a, b) => a.min_events - b.min_events);

  const rawMultipliers = Array.isArray(raw.duration_multipliers)
    ? raw.duration_multipliers
    : DEFAULT_PRICING_CONFIG.durationMultipliers;
  const durationMultipliers: DurationMultiplierTier[] = rawMultipliers
    .map((item) => {
      const r = item as Record<string, unknown>;
      return {
        months: Math.max(1, Math.floor(Number(r.months ?? 3))),
        mult: Math.max(0.1, Number(r.mult ?? 1.0)),
      };
    })
    .filter((m) => Number.isFinite(m.months) && Number.isFinite(m.mult))
    .sort((a, b) => a.months - b.months);

  const rawAllowedMonths = Array.isArray(raw.allowed_months)
    ? raw.allowed_months.map((m) => Number(m)).filter((m) => Number.isInteger(m) && m > 0)
    : durationMultipliers.map((m) => m.months);

  return {
    eventFeePkr: Math.max(
      0,
      Number(raw.event_fee_pkr ?? DEFAULT_PRICING_CONFIG.eventFeePkr),
    ),
    certRatePkr: Math.max(
      0,
      Number(raw.cert_rate_pkr ?? DEFAULT_PRICING_CONFIG.certRatePkr),
    ),
    volumeDiscounts:
      volumeDiscounts.length > 0
        ? volumeDiscounts
        : DEFAULT_PRICING_CONFIG.volumeDiscounts,
    durationMultipliers:
      durationMultipliers.length > 0
        ? durationMultipliers
        : DEFAULT_PRICING_CONFIG.durationMultipliers,
    roundingPkr: Math.max(
      1,
      Math.floor(Number(raw.rounding_pkr ?? DEFAULT_PRICING_CONFIG.roundingPkr)),
    ),
    minEvents: Math.max(
      1,
      Math.floor(Number(raw.min_events ?? DEFAULT_PRICING_CONFIG.minEvents)),
    ),
    maxEvents: Math.max(
      1,
      Math.floor(Number(raw.max_events ?? DEFAULT_PRICING_CONFIG.maxEvents)),
    ),
    minCertsPerEvent: Math.max(
      1,
      Math.floor(
        Number(raw.min_certs_per_event ?? DEFAULT_PRICING_CONFIG.minCertsPerEvent),
      ),
    ),
    maxCertsPerEvent: Math.max(
      25,
      Math.floor(
        Number(raw.max_certs_per_event ?? DEFAULT_PRICING_CONFIG.maxCertsPerEvent),
      ),
    ),
    certsStep: Math.max(
      1,
      Math.floor(Number(raw.certs_step ?? DEFAULT_PRICING_CONFIG.certsStep)),
    ),
    allowedMonths:
      rawAllowedMonths.length > 0
        ? rawAllowedMonths
        : DEFAULT_PRICING_CONFIG.allowedMonths,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

/**
 * Validates `{ events, certsPerEvent, months }` against `PricingConfig` limits:
 * - events: 1..20 (integer)
 * - certsPerEvent: 25..500 step 25 (integer)
 * - months: 3 | 6 | 12 (must exist in durationMultipliers & allowedMonths)
 */
export function validatePricingInput(
  input: ComputePriceInput,
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
): { valid: true; normalized: Required<ComputePriceInput> } | { valid: false; error: string } {
  const events = Number(input.events);
  const certsPerEvent = Number(input.certsPerEvent);
  const months = input.months === undefined ? 3 : Number(input.months);

  if (
    !Number.isInteger(events) ||
    events < config.minEvents ||
    events > config.maxEvents
  ) {
    return {
      valid: false,
      error: `Events must be a whole number between ${config.minEvents} and ${config.maxEvents}.`,
    };
  }

  if (
    !Number.isInteger(certsPerEvent) ||
    certsPerEvent < config.minCertsPerEvent ||
    certsPerEvent > config.maxCertsPerEvent
  ) {
    return {
      valid: false,
      error: `Certificates per event must be between ${config.minCertsPerEvent} and ${config.maxCertsPerEvent}.`,
    };
  }

  if (certsPerEvent % config.certsStep !== 0) {
    return {
      valid: false,
      error: `Certificates per event must be in increments of ${config.certsStep}.`,
    };
  }

  const hasMultiplier = config.durationMultipliers.some(
    (m) => m.months === months,
  );
  if (!Number.isInteger(months) || !config.allowedMonths.includes(months) || !hasMultiplier) {
    return {
      valid: false,
      error: `Package duration must be one of ${config.allowedMonths.join(", ")} months.`,
    };
  }

  return {
    valid: true,
    normalized: { events, certsPerEvent, months },
  };
}

/**
 * Resolves the volume discount rate for a given `events` count by picking the
 * highest `min_events <= events` tier from `config.volumeDiscounts`.
 */
export function resolveVolumeDiscount(
  events: number,
  volumeDiscounts: VolumeDiscountTier[],
): number {
  let applicable = 0;
  const sorted = [...volumeDiscounts].sort((a, b) => a.min_events - b.min_events);
  for (const tier of sorted) {
    if (events >= tier.min_events) {
      applicable = tier.discount;
    }
  }
  return Math.min(0.95, Math.max(0, applicable));
}

/**
 * Resolves the duration multiplier for `months` from `config.durationMultipliers`.
 */
export function resolveDurationMultiplier(
  months: number,
  durationMultipliers: DurationMultiplierTier[],
): number {
  const found = durationMultipliers.find((t) => t.months === months);
  if (!found) {
    throw new Error(
      `Unsupported duration ${months} months (allowed: ${durationMultipliers
        .map((d) => d.months)
        .join(", ")}).`,
    );
  }
  return found.mult;
}

/**
 * Shared pure pricing function used on the landing page, billing page, and server.
 *
 * Formula:
 *   perEvent = event_fee_pkr + cert_rate_pkr * certsPerEvent
 *   total = events * perEvent * (1 - discount) * durationMultiplier,
 *           rounded to nearest rounding_pkr.
 *
 * Throws if `{ events, certsPerEvent, months }` violates `config` limits.
 */
export function computePrice(
  input: ComputePriceInput,
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
): ComputedPriceBreakdown {
  const check = validatePricingInput(input, config);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const { events, certsPerEvent, months } = check.normalized;
  const perEventPricePkr =
    config.eventFeePkr + config.certRatePkr * certsPerEvent;
  const undiscountedSubtotalPkr = events * perEventPricePkr;
  const discountRate = resolveVolumeDiscount(events, config.volumeDiscounts);
  const discountPercent = Math.round(discountRate * 10000) / 100;
  const discountedSubtotalPkr = undiscountedSubtotalPkr * (1 - discountRate);
  const durationMultiplier = resolveDurationMultiplier(
    months,
    config.durationMultipliers,
  );

  const rawTotalPkr = discountedSubtotalPkr * durationMultiplier;
  const finalPricePkr = roundToIncrement(rawTotalPkr, config.roundingPkr);
  const listPricePkr = roundToIncrement(
    undiscountedSubtotalPkr * durationMultiplier,
    config.roundingPkr,
  );
  const discountPkr = Math.max(0, listPricePkr - finalPricePkr);

  return {
    events,
    certsPerEvent,
    months,
    totalCertificatesCapacity: events * certsPerEvent,
    perEventPricePkr,
    undiscountedSubtotalPkr,
    discountRate,
    discountPercent,
    discountedSubtotalPkr,
    durationMultiplier,
    rawTotalPkr,
    listPricePkr,
    discountPkr,
    finalPricePkr,
    totalPkr: finalPricePkr,
  };
}

/**
 * Pure server/client calculation for an event certificate top-up:
 *   amount_pkr = certsAdded * cert_rate_pkr
 */
export function computeTopupPrice(
  certsAdded: number,
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
): {
  certsAdded: number;
  certRatePkr: number;
  amountPkr: number;
} {
  if (
    !Number.isInteger(certsAdded) ||
    certsAdded < config.certsStep ||
    certsAdded > 5000 ||
    certsAdded % config.certsStep !== 0
  ) {
    throw new Error(
      `Top-up certificates must be between ${config.certsStep} and 5,000 in increments of ${config.certsStep}.`,
    );
  }
  return {
    certsAdded,
    certRatePkr: config.certRatePkr,
    amountPkr: certsAdded * config.certRatePkr,
  };
}

/**
 * Attaches live `computePrice` breakdowns to each preset plan row.
 */
export function attachPricesToPresets(
  presets: PlanPreset[],
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
): PricedPlanPreset[] {
  return [...presets]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((preset) => ({
      ...preset,
      pricing: computePrice(
        {
          events: preset.eventsCount,
          certsPerEvent: preset.certsPerEvent,
          months: preset.months,
        },
        config,
      ),
    }));
}

/**
 * Formats a friendly relative expiry label such as `"expires in 41 days"`,
 * `"expires today"`, or `"expired"`.
 */
export function formatExpiryCountdown(
  expiresAtIso: string | null | undefined,
  nowMs = Date.now(),
): { label: string; daysRemaining: number | null; isExpired: boolean } {
  if (!expiresAtIso) {
    return { label: "no expiry", daysRemaining: null, isExpired: false };
  }
  const ts = Date.parse(expiresAtIso);
  if (Number.isNaN(ts)) {
    return { label: "—", daysRemaining: null, isExpired: false };
  }
  if (ts <= nowMs) {
    return { label: "expired", daysRemaining: 0, isExpired: true };
  }
  const days = Math.ceil((ts - nowMs) / 86_400_000);
  if (days <= 1) {
    return { label: "expires in 1 day", daysRemaining: 1, isExpired: false };
  }
  return {
    label: `expires in ${days} days`,
    daysRemaining: days,
    isExpired: false,
  };
}
