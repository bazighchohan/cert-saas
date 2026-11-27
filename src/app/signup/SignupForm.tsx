"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signupAction } from "@/app/auth/actions";
import {
  computePrice,
  type PricedPlanPreset,
  type PricingConfig,
} from "@/lib/pricing";

export interface InitialSignupPlanSelection {
  cameFromUrl: boolean;
  selectionType: "preset" | "custom";
  planId: string;
  events: number;
  certsPerEvent: number;
  months: number;
}

export default function SignupForm({
  pricingConfig,
  presets,
  initialSelection,
}: {
  pricingConfig: PricingConfig;
  presets: PricedPlanPreset[];
  initialSelection?: InitialSignupPlanSelection;
}) {
  const router = useRouter();
  const submittingRef = useRef(false);
  const [idempotencyKey] = useState(
    () =>
      `signup_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );

  // Contact & organization fields
  const [orgName, setOrgName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [password, setPassword] = useState("");

  // Plan picker state (preselected if coming from landing page; open picker if none chosen)
  const [showPlanPicker, setShowPlanPicker] = useState(
    !initialSelection?.cameFromUrl,
  );
  const [selectionType, setSelectionType] = useState<"preset" | "custom">(
    initialSelection?.selectionType ?? "preset",
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    initialSelection?.planId ?? presets[0]?.id ?? "single-50",
  );
  const [customEvents, setCustomEvents] = useState<number>(
    initialSelection?.events ?? 3,
  );
  const [customCerts, setCustomCerts] = useState<number>(
    initialSelection?.certsPerEvent ?? 100,
  );
  const [customMonths, setCustomMonths] = useState<number>(
    initialSelection?.months ?? 3,
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreset =
    presets.find((p) => p.id === selectedPresetId) ?? presets[0];

  const liveBreakdown = useMemo(() => {
    if (selectionType === "preset" && selectedPreset) {
      return selectedPreset.pricing;
    }
    return computePrice(
      {
        events: Math.min(
          pricingConfig.maxEvents,
          Math.max(pricingConfig.minEvents, customEvents),
        ),
        certsPerEvent: Math.min(
          pricingConfig.maxCertsPerEvent,
          Math.max(pricingConfig.minCertsPerEvent, customCerts),
        ),
        months: customMonths,
      },
      pricingConfig,
    );
  }, [
    selectionType,
    selectedPreset,
    customEvents,
    customCerts,
    customMonths,
    pricingConfig,
  ]);

  const selectedPlanLabel =
    selectionType === "preset" && selectedPreset
      ? selectedPreset.name
      : `Custom Package (${liveBreakdown.events} × ${liveBreakdown.certsPerEvent} certs)`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submittingRef.current || loading) {
      return;
    }

    submittingRef.current = true;
    setError(null);
    setLoading(true);

    try {
      const res = await signupAction({
        orgName,
        contactName,
        email,
        password,
        whatsappNumber,
        selectionType,
        planId:
          selectionType === "preset" ? (selectedPreset?.id ?? "") : "",
        events:
          selectionType === "custom" ? liveBreakdown.events : undefined,
        certsPerEvent:
          selectionType === "custom"
            ? liveBreakdown.certsPerEvent
            : undefined,
        months:
          selectionType === "custom" ? liveBreakdown.months : undefined,
        idempotencyKey,
      });

      if (res.error) {
        setError(res.error);
        if (res.redirectTo) {
          router.push(res.redirectTo);
        }
        return;
      }

      router.push(res.redirectTo || "/pending");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Selected Plan Summary / Plan Picker */}
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wide text-indigo-700">
              Selected Package
            </span>
            <p className="mt-0.5 text-sm font-bold text-slate-900">
              {selectedPlanLabel} ·{" "}
              <span className="font-mono text-indigo-700">
                PKR {liveBreakdown.finalPricePkr.toLocaleString()}
              </span>
            </p>
            <p className="text-xs text-slate-600">
              {liveBreakdown.events}{" "}
              {liveBreakdown.events === 1 ? "event" : "events"} ×{" "}
              {liveBreakdown.certsPerEvent} certificates/event · Valid{" "}
              {liveBreakdown.months} months
              {liveBreakdown.discountPercent > 0
                ? ` (${liveBreakdown.discountPercent}% volume discount; list PKR ${liveBreakdown.listPricePkr.toLocaleString()})`
                : ""}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowPlanPicker((v) => !v)}
            disabled={loading}
            className="rounded-xl border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
          >
            {showPlanPicker ? "Hide Plan Picker" : "Change Plan"}
          </button>
        </div>

        {showPlanPicker && (
          <div className="mt-4 space-y-4 border-t border-indigo-200/70 pt-4">
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-white p-1 text-xs font-bold ring-1 ring-slate-200">
              <button
                type="button"
                onClick={() => setSelectionType("preset")}
                className={`rounded-lg py-2 transition ${
                  selectionType === "preset"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                Preset Packages
              </button>
              <button
                type="button"
                onClick={() => setSelectionType("custom")}
                className={`rounded-lg py-2 transition ${
                  selectionType === "custom"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                Custom Package
              </button>
            </div>

            {selectionType === "preset" ? (
              <div className="grid gap-2.5 sm:grid-cols-2">
                {presets.map((preset) => {
                  const active = selectedPreset?.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setSelectedPresetId(preset.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        active
                          ? "border-indigo-600 bg-white ring-2 ring-indigo-500/25"
                          : "border-slate-200 bg-white/90 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900">
                          {preset.name}
                        </span>
                        <span className="font-mono text-xs font-extrabold text-indigo-700">
                          PKR {preset.pricing.totalPkr.toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {preset.eventsCount}{" "}
                        {preset.eventsCount === 1 ? "event" : "events"} ·{" "}
                        {preset.certsPerEvent} certs/event · {preset.months}{" "}
                        months
                      </p>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3.5">
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700">
                    <label htmlFor="signup-events">Number of events</label>
                    <span className="font-mono text-indigo-700">
                      {customEvents} event{customEvents === 1 ? "" : "s"}
                    </span>
                  </div>
                  <input
                    id="signup-events"
                    type="range"
                    min={pricingConfig.minEvents}
                    max={pricingConfig.maxEvents}
                    step={1}
                    value={customEvents}
                    onChange={(e) => setCustomEvents(Number(e.target.value))}
                    className="mt-1 w-full accent-indigo-600"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700">
                    <label htmlFor="signup-certs">Certificates per event</label>
                    <span className="font-mono text-indigo-700">
                      {customCerts} certs / event
                    </span>
                  </div>
                  <input
                    id="signup-certs"
                    type="range"
                    min={pricingConfig.minCertsPerEvent}
                    max={pricingConfig.maxCertsPerEvent}
                    step={pricingConfig.certsStep}
                    value={customCerts}
                    onChange={(e) => setCustomCerts(Number(e.target.value))}
                    className="mt-1 w-full accent-indigo-600"
                  />
                </div>

                <div>
                  <span className="block text-xs font-semibold text-slate-700">
                    Validity duration
                  </span>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {pricingConfig.durationMultipliers.map((tier) => (
                      <button
                        key={tier.months}
                        type="button"
                        onClick={() => setCustomMonths(tier.months)}
                        className={`rounded-lg border py-1.5 text-xs font-bold ${
                          customMonths === tier.months
                            ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        {tier.months} months ({tier.mult}×)
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Organization & Contact Details */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label
            htmlFor="orgName"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            Organization name
          </label>
          <input
            id="orgName"
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. ACM Student Chapter, FAST University"
            required
            minLength={2}
            maxLength={200}
            autoFocus
            disabled={loading}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>

        <div>
          <label
            htmlFor="contactName"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            Contact person
          </label>
          <input
            id="contactName"
            type="text"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="e.g. Ayesha Khan"
            required
            minLength={2}
            maxLength={200}
            autoComplete="name"
            disabled={loading}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>

        <div>
          <label
            htmlFor="whatsappNumber"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            WhatsApp number
          </label>
          <input
            id="whatsappNumber"
            type="tel"
            value={whatsappNumber}
            onChange={(e) => setWhatsappNumber(e.target.value)}
            placeholder="+92 300 1234567"
            required
            minLength={6}
            maxLength={30}
            autoComplete="tel"
            disabled={loading}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>

        <div>
          <label
            htmlFor="email"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            Work or university email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@organization.edu"
            autoComplete="email"
            required
            disabled={loading}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
            minLength={8}
            disabled={loading}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="flex w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-70"
      >
        {loading ? "Submitting Request..." : "Submit Organization Request"}
      </button>

      <p className="text-center text-xs text-slate-600">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-semibold text-indigo-600 hover:text-indigo-500"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
