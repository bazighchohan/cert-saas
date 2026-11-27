"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  computePrice,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";

export default function LandingPricingCalculator({
  pricingConfig,
  presets,
  isSignedIn,
}: {
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
  isSignedIn: boolean;
}) {
  const [events, setEvents] = useState(3);
  const [certsPerEvent, setCertsPerEvent] = useState(100);
  const [months, setMonths] = useState<number>(3);

  const customBreakdown = useMemo(
    () =>
      computePrice(
        {
          events: Math.min(
            pricingConfig.maxEvents,
            Math.max(pricingConfig.minEvents, events),
          ),
          certsPerEvent: Math.min(
            pricingConfig.maxCertsPerEvent,
            Math.max(pricingConfig.minCertsPerEvent, certsPerEvent),
          ),
          months,
        },
        pricingConfig,
      ),
    [events, certsPerEvent, months, pricingConfig],
  );

  const ctaHref = isSignedIn ? "/dashboard/billing" : "/signup";
  const ctaLabel = isSignedIn ? "Buy in Dashboard →" : "Get Started →";

  return (
    <div className="space-y-12">
      {/* 1. Preset Packages */}
      <div>
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            Simple, Transparent Event Packages
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Pay per event &amp; certificate capacity via Bank Transfer, JazzCash,
            or Easypaisa. Released certificates stay live for 12 months.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {presets.map((preset) => {
            const isPro = preset.kind === "pro";
            return (
              <div
                key={preset.id}
                className={`flex flex-col justify-between rounded-2xl border p-5 shadow-xs transition ${
                  isPro
                    ? "border-indigo-500 bg-indigo-950 text-white ring-2 ring-indigo-500/20"
                    : "border-slate-200 bg-white text-slate-900"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                        isPro
                          ? "bg-indigo-500/30 text-indigo-100"
                          : "bg-indigo-50 text-indigo-700"
                      }`}
                    >
                      {preset.kind}
                    </span>
                    {preset.pricing.discountPercent > 0 && (
                      <span
                        className={`text-[11px] font-bold ${
                          isPro ? "text-emerald-300" : "text-emerald-600"
                        }`}
                      >
                        Save {preset.pricing.discountPercent}%
                      </span>
                    )}
                  </div>

                  <h3 className="mt-3 text-base font-bold">{preset.name}</h3>
                  <p className="mt-2 text-2xl font-extrabold">
                    PKR {preset.pricing.totalPkr.toLocaleString()}
                  </p>
                  <p
                    className={`mt-0.5 text-xs ${
                      isPro ? "text-indigo-200" : "text-slate-500"
                    }`}
                  >
                    Valid for {preset.months} months
                  </p>

                  <ul
                    className={`mt-4 space-y-1.5 text-xs ${
                      isPro ? "text-indigo-100" : "text-slate-600"
                    }`}
                  >
                    <li>
                      ✓ <strong>{preset.eventsCount}</strong>{" "}
                      {preset.eventsCount === 1 ? "event slot" : "event slots"}
                    </li>
                    <li>
                      ✓ <strong>{preset.certsPerEvent}</strong> certificates / event
                    </li>
                    <li>✓ 12-month public download retention</li>
                    <li>✓ QR verification &amp; CSV/Excel import</li>
                  </ul>
                </div>

                <Link
                  href={ctaHref}
                  className={`mt-5 block rounded-xl px-3.5 py-2.5 text-center text-xs font-bold transition ${
                    isPro
                      ? "bg-white text-indigo-950 hover:bg-indigo-50"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                  }`}
                >
                  {ctaLabel}
                </Link>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Custom Interactive Package Calculator */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="grid gap-8 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <div>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-indigo-700">
                Custom Package Builder
              </span>
              <h3 className="mt-2 text-xl font-bold text-slate-900">
                Calculate your exact organization package
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Base fee PKR {pricingConfig.eventFeePkr.toLocaleString()}/event +
                PKR {pricingConfig.certRatePkr}/certificate, with automatic
                multi-event volume discounts up to 50%.
              </p>
            </div>

            {/* Events slider */}
            <div>
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="calc-events" className="font-semibold text-slate-700">
                  Number of events
                </label>
                <span className="font-mono font-bold text-indigo-700">
                  {events} {events === 1 ? "event" : "events"}
                </span>
              </div>
              <input
                id="calc-events"
                type="range"
                min={pricingConfig.minEvents}
                max={pricingConfig.maxEvents}
                step={1}
                value={events}
                onChange={(e) => setEvents(Number(e.target.value))}
                className="mt-2 w-full accent-indigo-600"
              />
              <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                <span>{pricingConfig.minEvents} event</span>
                <span>2+ (20% off)</span>
                <span>4+ (35% off)</span>
                <span>7+ (50% off)</span>
                <span>{pricingConfig.maxEvents} events</span>
              </div>
            </div>

            {/* Certs per event slider */}
            <div>
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="calc-certs" className="font-semibold text-slate-700">
                  Certificates per event
                </label>
                <span className="font-mono font-bold text-indigo-700">
                  {certsPerEvent} certificates / event
                </span>
              </div>
              <input
                id="calc-certs"
                type="range"
                min={pricingConfig.minCertsPerEvent}
                max={pricingConfig.maxCertsPerEvent}
                step={pricingConfig.certsStep}
                value={certsPerEvent}
                onChange={(e) => setCertsPerEvent(Number(e.target.value))}
                className="mt-2 w-full accent-indigo-600"
              />
              <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                <span>{pricingConfig.minCertsPerEvent}</span>
                <span>150</span>
                <span>300</span>
                <span>{pricingConfig.maxCertsPerEvent}</span>
              </div>
            </div>

            {/* Duration selector */}
            <div>
              <span className="block text-sm font-semibold text-slate-700">
                Package validity window (to create events)
              </span>
              <div className="mt-2 grid grid-cols-3 gap-2.5">
                {pricingConfig.durationMultipliers.map((tier) => {
                  const selected = months === tier.months;
                  return (
                    <button
                      key={tier.months}
                      type="button"
                      onClick={() => setMonths(tier.months)}
                      className={`rounded-xl border px-3 py-2.5 text-xs font-bold transition ${
                        selected
                          ? "border-indigo-600 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-500/20"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {tier.months} Months
                      <span className="block text-[10px] font-medium text-slate-500">
                        {tier.mult === 1
                          ? "Standard (1.0×)"
                          : `${tier.mult}× multiplier`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Breakdown Card */}
          <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-slate-50 p-6 lg:col-span-2">
            <div className="space-y-3 text-xs text-slate-600">
              <h4 className="text-sm font-bold text-slate-900">
                Live Price Breakdown
              </h4>

              <div className="flex justify-between">
                <span>Per-event base + certs ({certsPerEvent} × PKR {pricingConfig.certRatePkr})</span>
                <span className="font-mono font-semibold text-slate-900">
                  PKR {customBreakdown.perEventPricePkr.toLocaleString()}
                </span>
              </div>

              <div className="flex justify-between">
                <span>Subtotal ({events} × PKR {customBreakdown.perEventPricePkr.toLocaleString()})</span>
                <span className="font-mono font-semibold text-slate-900">
                  PKR {customBreakdown.undiscountedSubtotalPkr.toLocaleString()}
                </span>
              </div>

              <div className="flex justify-between text-emerald-700">
                <span>Volume discount ({customBreakdown.discountPercent}%)</span>
                <span className="font-mono font-semibold">
                  {customBreakdown.discountPercent > 0
                    ? `−${customBreakdown.discountPercent}%`
                    : "0%"}
                </span>
              </div>

              <div className="flex justify-between">
                <span>Duration multiplier ({months} months)</span>
                <span className="font-mono font-semibold text-slate-900">
                  {customBreakdown.durationMultiplier}×
                </span>
              </div>

              <div className="border-t border-slate-200 pt-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-bold text-slate-900">
                    Total Package Price
                  </span>
                  <span className="font-mono text-2xl font-extrabold text-indigo-700">
                    PKR {customBreakdown.totalPkr.toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Up to{" "}
                  <strong>
                    {customBreakdown.totalCertificatesCapacity.toLocaleString()}
                  </strong>{" "}
                  certificates across {events} event{events === 1 ? "" : "s"} · Need
                  extra certificates later? Top up anytime at PKR{" "}
                  {pricingConfig.certRatePkr}/cert.
                </p>
              </div>
            </div>

            <Link
              href={ctaHref}
              className="mt-6 block rounded-xl bg-indigo-600 px-4 py-3 text-center text-sm font-bold text-white shadow-xs transition hover:bg-indigo-700"
            >
              {ctaLabel}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
