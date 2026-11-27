import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachPricesToPresets,
  computePrice,
  computeTopupPrice,
  DEFAULT_PLAN_PRESETS,
  DEFAULT_PRICING_CONFIG,
  formatExpiryCountdown,
  parsePricingConfigRow,
  validatePricingInput,
} from "../pricing";

describe("computePrice — exact formula, presets, dynamic config, and boundaries", () => {
  it("computes exact required prices: 1x50=750, 1x100=1000, 3x50=1800, 3x100=2400, 10x100(12m)=5500, 5x150(6m)=4250", () => {
    // 1. 1 event × 50 certs (3 months default) -> 750
    const p1x50 = computePrice({ events: 1, certsPerEvent: 50 });
    assert.equal(p1x50.perEventPricePkr, 750);
    assert.equal(p1x50.discountPercent, 0);
    assert.equal(p1x50.durationMultiplier, 1.0);
    assert.equal(p1x50.totalPkr, 750);

    // 2. 1 event × 100 certs (3 months) -> 1000
    const p1x100 = computePrice({ events: 1, certsPerEvent: 100, months: 3 });
    assert.equal(p1x100.perEventPricePkr, 1000);
    assert.equal(p1x100.totalPkr, 1000);

    // 3. 3 events × 50 certs (3 months, 20% volume discount) -> 1800
    const p3x50 = computePrice({ events: 3, certsPerEvent: 50, months: 3 });
    assert.equal(p3x50.perEventPricePkr, 750);
    assert.equal(p3x50.discountRate, 0.2);
    assert.equal(p3x50.totalPkr, 1800);

    // 4. 3 events × 100 certs (3 months, 20% volume discount) -> 2400
    const p3x100 = computePrice({ events: 3, certsPerEvent: 100, months: 3 });
    assert.equal(p3x100.perEventPricePkr, 1000);
    assert.equal(p3x100.discountRate, 0.2);
    assert.equal(p3x100.totalPkr, 2400);

    // 5. 10 events × 100 certs for 12 months (50% discount, 1.1x duration) -> 5500
    const p10x100m12 = computePrice({
      events: 10,
      certsPerEvent: 100,
      months: 12,
    });
    assert.equal(p10x100m12.perEventPricePkr, 1000);
    assert.equal(p10x100m12.discountRate, 0.5);
    assert.equal(p10x100m12.durationMultiplier, 1.1);
    assert.equal(p10x100m12.totalPkr, 5500);

    // 6. 5 events × 150 certs for 6 months (35% discount, 1.05x duration, rounded to 50) -> 4250
    const p5x150m6 = computePrice({
      events: 5,
      certsPerEvent: 150,
      months: 6,
    });
    assert.equal(p5x150m6.perEventPricePkr, 1250);
    assert.equal(p5x150m6.discountRate, 0.35);
    assert.equal(p5x150m6.durationMultiplier, 1.05);
    assert.equal(p5x150m6.totalPkr, 4250);
  });

  it("recomputes every preset and custom price dynamically when pricing_config values change", () => {
    const initialPresets = attachPricesToPresets(
      DEFAULT_PLAN_PRESETS,
      DEFAULT_PRICING_CONFIG,
    );
    assert.equal(
      initialPresets.find((p) => p.id === "single-50")?.pricing.totalPkr,
      750,
    );
    assert.equal(
      initialPresets.find((p) => p.id === "pro")?.pricing.totalPkr,
      5500,
    );

    // Simulate superadmin updating pricing_config in DB (event_fee_pkr = 800, cert_rate_pkr = 10)
    const updatedConfig = parsePricingConfigRow({
      event_fee_pkr: 800,
      cert_rate_pkr: 10,
      volume_discounts: DEFAULT_PRICING_CONFIG.volumeDiscounts,
      duration_multipliers: DEFAULT_PRICING_CONFIG.durationMultipliers,
      rounding_pkr: 50,
    });

    const updatedPresets = attachPricesToPresets(
      DEFAULT_PLAN_PRESETS,
      updatedConfig,
    );
    // Single 50: 800 + 10*50 = 1300
    assert.equal(
      updatedPresets.find((p) => p.id === "single-50")?.pricing.totalPkr,
      1300,
    );
    // Pro (10 × 100, 12m): perEvent = 1800, * 10 * 0.5 * 1.1 = 9900
    assert.equal(
      updatedPresets.find((p) => p.id === "pro")?.pricing.totalPkr,
      9900,
    );
    // Top-up of 50 certs: 50 * 10 = 500 (vs 250 previously)
    assert.equal(computeTopupPrice(50, DEFAULT_PRICING_CONFIG).amountPkr, 250);
    assert.equal(computeTopupPrice(50, updatedConfig).amountPkr, 500);
  });

  it("rejects out-of-range events, non-step-25 certificate counts, and invalid month durations", () => {
    assert.equal(
      validatePricingInput({ events: 0, certsPerEvent: 50, months: 3 }).valid,
      false,
    );
    assert.equal(
      validatePricingInput({ events: 21, certsPerEvent: 50, months: 3 }).valid,
      false,
    );
    assert.equal(
      validatePricingInput({ events: 1, certsPerEvent: 20, months: 3 }).valid,
      false,
    );
    assert.equal(
      validatePricingInput({ events: 1, certsPerEvent: 525, months: 3 }).valid,
      false,
    );
    assert.equal(
      validatePricingInput({ events: 1, certsPerEvent: 60, months: 3 }).valid,
      false,
    );
    assert.equal(
      validatePricingInput({ events: 1, certsPerEvent: 50, months: 4 }).valid,
      false,
    );
    assert.throws(() => computeTopupPrice(30)); // not multiple of 25
  });

  it("formats relative expiry countdown strings ('expires in 41 days')", () => {
    const now = Date.parse("2026-11-27T00:00:00Z");
    const in41Days = new Date(now + 41 * 86_400_000).toISOString();
    const res = formatExpiryCountdown(in41Days, now);
    assert.equal(res.label, "expires in 41 days");
    assert.equal(res.daysRemaining, 41);
    assert.equal(res.isExpired, false);
  });
});
