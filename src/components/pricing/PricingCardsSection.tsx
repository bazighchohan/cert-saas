"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  buildSignupHrefForPlan,
  type SelectedPlanChoice,
} from "@/lib/plan-selection";
import {
  computePrice,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";

export interface PricingCardsSectionProps {
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
  isSignedIn: boolean;
  showPilotBanner?: boolean;
  headingLevel?: "h1" | "h2";
  onSelectPlan?: (choice: SelectedPlanChoice) => void;
}

export default function PricingCardsSection({
  pricingConfig,
  presets,
  isSignedIn,
  showPilotBanner = true,
  headingLevel = "h2",
  onSelectPlan,
}: PricingCardsSectionProps) {
  // Card 1: Single Event toggle (50 / 100 certs)
  const [singleCerts, setSingleCerts] = useState<50 | 100>(100);
  // Card 2: Multiple Events toggle (50 / 100 certs per event, 3 events / 3 months)
  const [multiCerts, setMultiCerts] = useState<50 | 100>(100);

  // Card 4: Build Your Own sliders
  const [customEvents, setCustomEvents] = useState<number>(5);
  const [customCerts, setCustomCerts] = useState<number>(150);
  const [customMonths, setCustomMonths] = useState<number>(3);

  const singlePreset = useMemo(() => {
    const id = singleCerts === 50 ? "single-50" : "single-100";
    const found = presets.find((p) => p.id === id);
    if (found) return found;
    return {
      id,
      name: `Single (${singleCerts} certs)`,
      kind: "single" as const,
      eventsCount: 1,
      certsPerEvent: singleCerts,
      months: 3,
      allowCustomBranding: true,
      sortOrder: 1,
      pricing: computePrice(
        { events: 1, certsPerEvent: singleCerts, months: 3 },
        pricingConfig,
      ),
    };
  }, [presets, singleCerts, pricingConfig]);

  const multiPreset = useMemo(() => {
    const id = multiCerts === 50 ? "multi-50" : "multi-100";
    const found = presets.find((p) => p.id === id);
    if (found) return found;
    return {
      id,
      name: `Multi (3 × ${multiCerts} certs)`,
      kind: "multi" as const,
      eventsCount: 3,
      certsPerEvent: multiCerts,
      months: 3,
      allowCustomBranding: true,
      sortOrder: 3,
      pricing: computePrice(
        { events: 3, certsPerEvent: multiCerts, months: 3 },
        pricingConfig,
      ),
    };
  }, [presets, multiCerts, pricingConfig]);

  const proPreset = useMemo(() => {
    const found = presets.find((p) => p.id === "pro");
    if (found) return found;
    return {
      id: "pro",
      name: "Pro (10 × 100 certs)",
      kind: "pro" as const,
      eventsCount: 10,
      certsPerEvent: 100,
      months: 12,
      allowCustomBranding: true,
      sortOrder: 5,
      pricing: computePrice(
        { events: 10, certsPerEvent: 100, months: 12 },
        pricingConfig,
      ),
    };
  }, [presets, pricingConfig]);

  const clampedCustomEvents = Math.min(
    pricingConfig.maxEvents,
    Math.max(pricingConfig.minEvents, customEvents),
  );
  const clampedCustomCerts = Math.min(
    pricingConfig.maxCertsPerEvent,
    Math.max(pricingConfig.minCertsPerEvent, customCerts),
  );
  const validCustomMonths = pricingConfig.allowedMonths.includes(customMonths)
    ? customMonths
    : (pricingConfig.allowedMonths[0] ?? 3);

  const customBreakdown = useMemo(
    () =>
      computePrice(
        {
          events: clampedCustomEvents,
          certsPerEvent: clampedCustomCerts,
          months: validCustomMonths,
        },
        pricingConfig,
      ),
    [clampedCustomEvents, clampedCustomCerts, validCustomMonths, pricingConfig],
  );

  const singlePerEvent = Math.round(
    singlePreset.pricing.totalPkr / Math.max(1, singlePreset.eventsCount),
  );
  const multiPerEvent = Math.round(
    multiPreset.pricing.totalPkr / Math.max(1, multiPreset.eventsCount),
  );
  const proPerEvent = Math.round(
    proPreset.pricing.totalPkr / Math.max(1, proPreset.eventsCount),
  );
  const customPerEvent = Math.round(
    customBreakdown.totalPkr / Math.max(1, clampedCustomEvents),
  );

  const HeadingTag = headingLevel;

  function renderPlanCta(
    choice: SelectedPlanChoice,
    variant: "primary" | "inverted",
  ) {
    const label = onSelectPlan
      ? "Choose this plan"
      : isSignedIn
        ? "Buy in Billing →"
        : "Choose this plan";

    const classes =
      variant === "inverted"
        ? "mt-5 block w-full rounded-xl bg-white px-4 py-3 text-center text-sm font-bold text-indigo-950 shadow-xs transition hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        : "mt-5 block w-full rounded-xl bg-indigo-600 px-4 py-3 text-center text-sm font-bold text-white shadow-xs transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";

    if (onSelectPlan) {
      return (
        <button
          type="button"
          onClick={() => onSelectPlan(choice)}
          className={classes}
        >
          {label}
        </button>
      );
    }

    const href = isSignedIn
      ? "/dashboard/billing"
      : buildSignupHrefForPlan(choice);

    return (
      <Link href={href} className={classes}>
        {label}
      </Link>
    );
  }

  return (
    <div className="space-y-8">
      <div className="mx-auto max-w-3xl text-center">
        <HeadingTag className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Transparent Event Packages, No Subscriptions
        </HeadingTag>
        <p className="mt-3 text-base text-slate-700">
          Pick a preset package or build your own exact event &amp; certificate
          capacity. Every price updates live from our platform pricing engine.
        </p>
      </div>

      {/* Pilot Mode Banner (controlled by PILOT_BANNER_ENABLED flag) */}
      {showPilotBanner && (
        <div
          role="note"
          className="mx-auto flex max-w-3xl items-center justify-center gap-2.5 rounded-2xl border border-emerald-300 bg-emerald-50 px-5 py-3.5 text-center text-sm font-semibold text-emerald-950 shadow-2xs"
        >
          <span aria-hidden="true" className="text-base">
            ✨
          </span>
          <span>Pilot: approved by our team, no payment needed yet</span>
        </div>
      )}

      {/* 4 Pricing Cards Grid */}
      <div className="grid gap-6 lg:grid-cols-4">
        {/* CARD 1: SINGLE EVENT */}
        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-indigo-800">
                Single Event
              </span>
              <span className="text-xs font-medium text-slate-600">
                {singlePreset.months} months
              </span>
            </div>

            <h3 className="mt-3 text-lg font-bold text-slate-900">
              Single Event
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Ideal for a standalone seminar, hackathon, or society workshop.
            </p>

            {/* 50 / 100 certificates toggle */}
            <div
              role="group"
              aria-label="Single event certificates per event"
              className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 text-xs font-bold"
            >
              {([50, 100] as const).map((tier) => {
                const active = singleCerts === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSingleCerts(tier)}
                    className={`rounded-lg py-2 transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                      active
                        ? "bg-white text-indigo-800 shadow-2xs"
                        : "text-slate-700 hover:text-slate-900"
                    }`}
                  >
                    {tier} certificates
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <p className="text-3xl font-extrabold text-slate-900">
                PKR {singlePreset.pricing.totalPkr.toLocaleString()}
              </p>
              <p className="mt-1 text-xs font-semibold text-indigo-800">
                PKR {singlePerEvent.toLocaleString()} per event
              </p>
            </div>

            <ul className="mt-5 space-y-2 text-xs text-slate-700">
              <li>✓ 1 event within {singlePreset.months} months</li>
              <li>✓ Up to {singlePreset.certsPerEvent} certificates</li>
              <li>✓ Visual name editor &amp; QR verification</li>
              <li>✓ CSV &amp; Excel attendee import</li>
            </ul>
          </div>

          <div>
            {renderPlanCta(
              {
                selectionType: "preset",
                planId: singlePreset.id,
                events: singlePreset.eventsCount,
                certsPerEvent: singlePreset.certsPerEvent,
                months: singlePreset.months,
              },
              "primary",
            )}
            <p className="mt-2.5 text-center text-xs font-medium text-slate-600">
              PKR {singlePerEvent.toLocaleString()} / event
            </p>
          </div>
        </article>

        {/* CARD 2: MULTIPLE EVENTS */}
        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-indigo-800">
                Multiple Events
              </span>
              {multiPreset.pricing.discountPercent > 0 && (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                  Save {multiPreset.pricing.discountPercent}%
                </span>
              )}
            </div>

            <h3 className="mt-3 text-lg font-bold text-slate-900">
              Multiple Events
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              {multiPreset.eventsCount} events within {multiPreset.months}{" "}
              months for active university societies &amp; departments.
            </p>

            {/* 50 / 100 per event toggle */}
            <div
              role="group"
              aria-label="Multiple events certificates per event"
              className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 text-xs font-bold"
            >
              {([50, 100] as const).map((tier) => {
                const active = multiCerts === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMultiCerts(tier)}
                    className={`rounded-lg py-2 transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                      active
                        ? "bg-white text-indigo-800 shadow-2xs"
                        : "text-slate-700 hover:text-slate-900"
                    }`}
                  >
                    {tier} / event
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <p className="text-3xl font-extrabold text-slate-900">
                PKR {multiPreset.pricing.totalPkr.toLocaleString()}
              </p>
              <p className="mt-1 text-xs font-semibold text-indigo-800">
                PKR {multiPerEvent.toLocaleString()} per event
                {multiPreset.pricing.discountPkr > 0
                  ? ` (list PKR ${multiPreset.pricing.listPricePkr.toLocaleString()})`
                  : ""}
              </p>
            </div>

            <ul className="mt-5 space-y-2 text-xs text-slate-700">
              <li>
                ✓ {multiPreset.eventsCount} events within {multiPreset.months}{" "}
                months
              </li>
              <li>✓ {multiPreset.certsPerEvent} certificates per event</li>
              <li>✓ One-time or limited downloads</li>
              <li>✓ Real-time download analytics &amp; exports</li>
            </ul>
          </div>

          <div>
            {renderPlanCta(
              {
                selectionType: "preset",
                planId: multiPreset.id,
                events: multiPreset.eventsCount,
                certsPerEvent: multiPreset.certsPerEvent,
                months: multiPreset.months,
              },
              "primary",
            )}
            <p className="mt-2.5 text-center text-xs font-medium text-slate-600">
              PKR {multiPerEvent.toLocaleString()} / event
            </p>
          </div>
        </article>

        {/* CARD 3: PRO */}
        <article className="flex flex-col justify-between rounded-2xl border-2 border-indigo-500 bg-slate-900 p-6 text-white shadow-md">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-indigo-500/30 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-indigo-100">
                Pro Annual
              </span>
              {proPreset.pricing.discountPercent > 0 && (
                <span className="rounded-full bg-emerald-400/20 px-2.5 py-0.5 text-xs font-bold text-emerald-200">
                  Save {proPreset.pricing.discountPercent}%
                </span>
              )}
            </div>

            <h3 className="mt-3 text-lg font-bold text-white">Pro</h3>
            <p className="mt-1 text-xs text-slate-200">
              {proPreset.eventsCount} events across {proPreset.months} months
              for institutions, bootcamps, and conference series.
            </p>

            <div className="mt-5">
              <p className="text-3xl font-extrabold text-white">
                PKR {proPreset.pricing.totalPkr.toLocaleString()}
              </p>
              <p className="mt-1 text-xs font-semibold text-indigo-200">
                PKR {proPerEvent.toLocaleString()} per event ·{" "}
                {proPreset.months} months validity
              </p>
            </div>

            <ul className="mt-5 space-y-2 text-xs text-slate-100">
              <li>
                ✓ {proPreset.eventsCount} events for {proPreset.months} months
              </li>
              <li>
                ✓ {proPreset.certsPerEvent} certificates per event (
                {(
                  proPreset.eventsCount * proPreset.certsPerEvent
                ).toLocaleString()}{" "}
                total)
              </li>
              <li>✓ Multiple certificate types per event</li>
              <li>✓ Instant top-ups at PKR {pricingConfig.certRatePkr}/cert</li>
            </ul>
          </div>

          <div>
            {renderPlanCta(
              {
                selectionType: "preset",
                planId: proPreset.id,
                events: proPreset.eventsCount,
                certsPerEvent: proPreset.certsPerEvent,
                months: proPreset.months,
              },
              "inverted",
            )}
            <p className="mt-2.5 text-center text-xs font-medium text-slate-200">
              PKR {proPerEvent.toLocaleString()} / event
            </p>
          </div>
        </article>

        {/* CARD 4: BUILD YOUR OWN */}
        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-slate-800">
                Custom
              </span>
              {customBreakdown.discountPercent > 0 && (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                  {customBreakdown.discountPercent}% off
                </span>
              )}
            </div>

            <h3 className="mt-3 text-lg font-bold text-slate-900">
              Build Your Own
            </h3>

            {/* Sliders */}
            <div className="mt-4 space-y-3.5">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <label
                    htmlFor="byo-events-slider"
                    className="font-semibold text-slate-800"
                  >
                    Events ({pricingConfig.minEvents}–{pricingConfig.maxEvents})
                  </label>
                  <span className="font-mono font-bold text-indigo-800">
                    {clampedCustomEvents}
                  </span>
                </div>
                <input
                  id="byo-events-slider"
                  type="range"
                  min={pricingConfig.minEvents}
                  max={pricingConfig.maxEvents}
                  step={1}
                  value={clampedCustomEvents}
                  aria-valuetext={`${clampedCustomEvents} events`}
                  onChange={(e) => setCustomEvents(Number(e.target.value))}
                  className="mt-1.5 w-full accent-indigo-600"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label
                    htmlFor="byo-certs-slider"
                    className="font-semibold text-slate-800"
                  >
                    Certs / event ({pricingConfig.minCertsPerEvent}–
                    {pricingConfig.maxCertsPerEvent})
                  </label>
                  <span className="font-mono font-bold text-indigo-800">
                    {clampedCustomCerts}
                  </span>
                </div>
                <input
                  id="byo-certs-slider"
                  type="range"
                  min={pricingConfig.minCertsPerEvent}
                  max={pricingConfig.maxCertsPerEvent}
                  step={pricingConfig.certsStep}
                  value={clampedCustomCerts}
                  aria-valuetext={`${clampedCustomCerts} certificates per event`}
                  onChange={(e) => setCustomCerts(Number(e.target.value))}
                  className="mt-1.5 w-full accent-indigo-600"
                />
              </div>

              <div>
                <span className="block text-xs font-semibold text-slate-800">
                  Duration
                </span>
                <div
                  role="group"
                  aria-label="Custom package duration in months"
                  className="mt-1.5 grid grid-cols-3 gap-1.5"
                >
                  {pricingConfig.durationMultipliers.map((tier) => {
                    const selected = validCustomMonths === tier.months;
                    return (
                      <button
                        key={tier.months}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setCustomMonths(tier.months)}
                        className={`rounded-lg border py-1.5 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                          selected
                            ? "border-indigo-600 bg-indigo-50 text-indigo-800"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {tier.months}m
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Live Breakdown from computePrice */}
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <div className="flex items-baseline justify-between">
                <span className="font-bold text-slate-900">Live Total</span>
                <span className="font-mono text-xl font-extrabold text-indigo-800">
                  PKR {customBreakdown.totalPkr.toLocaleString()}
                </span>
              </div>
              <div className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-[11px]">
                <div className="flex justify-between">
                  <span>Base + {clampedCustomCerts} certs</span>
                  <span className="font-mono font-semibold text-slate-900">
                    PKR {customBreakdown.perEventPricePkr.toLocaleString()}/ev
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Volume discount</span>
                  <span className="font-mono font-semibold text-emerald-800">
                    {customBreakdown.discountPercent > 0
                      ? `−${customBreakdown.discountPercent}%`
                      : "0%"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Duration ({validCustomMonths}m)</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {customBreakdown.durationMultiplier}×
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div>
            {renderPlanCta(
              {
                selectionType: "custom",
                planId: "custom",
                events: clampedCustomEvents,
                certsPerEvent: clampedCustomCerts,
                months: validCustomMonths,
              },
              "primary",
            )}
            <p className="mt-2.5 text-center text-xs font-medium text-slate-600">
              PKR {customPerEvent.toLocaleString()} / event
            </p>
          </div>
        </article>
      </div>

      {/* Required Retention Note */}
      <p className="text-center text-sm font-medium text-slate-700">
        Certificates stay downloadable for 12 months after release.
      </p>
    </div>
  );
}
