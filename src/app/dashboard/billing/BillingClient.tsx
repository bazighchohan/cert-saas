"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import type { BillingDashboardData } from "@/lib/dashboard-data";
import {
  computePrice,
  computeTopupPrice,
  formatExpiryCountdown,
} from "@/lib/pricing";

type ManualMethod = "bank" | "jazzcash" | "easypaisa";

const METHOD_META: Record<ManualMethod, { label: string; instructions: string }> = {
  bank: {
    label: "Bank Transfer (IBFT / Raast)",
    instructions:
      "Send the exact PKR amount via IBFT / Raast, capture the transfer receipt, and enter the Bank Reference / STAN number below.",
  },
  jazzcash: {
    label: "JazzCash",
    instructions:
      "Send the exact PKR amount to our JazzCash merchant/wallet account, save the confirmation screenshot, and enter the 11–12 digit TID.",
  },
  easypaisa: {
    label: "Easypaisa",
    instructions:
      "Send the exact PKR amount to our Easypaisa account, save the receipt screenshot, and enter the Transaction ID (TID).",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function purchaseStatusBadge(status: "pending" | "active" | "rejected" | "expired") {
  if (status === "active") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
        ✓ Active
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
        ⏳ Waiting for Approval
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
        ⌛ Expired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">
      ✕ Rejected
    </span>
  );
}

export default function BillingClient({
  data,
  initialTopupEventId = null,
}: {
  data: BillingDashboardData;
  initialTopupEventId?: string | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const buyFileRef = useRef<HTMLInputElement | null>(null);
  const topupFileRef = useRef<HTMLInputElement | null>(null);

  const {
    org,
    purchases,
    activePurchases,
    pendingPurchases,
    eventsSlotsUsed,
    eventsSlotsTotal,
    eventsSlotsRemaining,
    soonestActiveExpiry,
    pricingConfig,
    presets,
    events,
    topups,
    isSuperAdmin,
  } = data;

  // Buy Package Modal state
  const [buyModalOpen, setBuyModalOpen] = useState(false);
  const [selectionType, setSelectionType] = useState<"preset" | "custom">("preset");
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    presets[0]?.id ?? "single-50",
  );
  const [customEvents, setCustomEvents] = useState(3);
  const [customCerts, setCustomCerts] = useState(100);
  const [customMonths, setCustomMonths] = useState(3);
  const [buyMethod, setBuyMethod] = useState<ManualMethod>("bank");
  const [buyTxRef, setBuyTxRef] = useState("");
  const [buyNote, setBuyNote] = useState("");
  const [buyScreenshot, setBuyScreenshot] = useState<File | null>(null);
  const [buySubmitting, setBuySubmitting] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);

  // Certificate Top-up Modal state
  const validInitialTopupEvent =
    initialTopupEventId && events.some((e) => e.id === initialTopupEventId)
      ? initialTopupEventId
      : null;

  const [topupModalOpen, setTopupModalOpen] = useState(
    Boolean(validInitialTopupEvent),
  );
  const [topupEventId, setTopupEventId] = useState<string>(
    validInitialTopupEvent ?? events[0]?.id ?? "",
  );
  const [topupCertsAdded, setTopupCertsAdded] = useState(50);
  const [topupMethod, setTopupMethod] = useState<ManualMethod>("bank");
  const [topupTxRef, setTopupTxRef] = useState("");
  const [topupNote, setTopupNote] = useState("");
  const [topupScreenshot, setTopupScreenshot] = useState<File | null>(null);
  const [topupSubmitting, setTopupSubmitting] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);

  const selectedPreset =
    presets.find((p) => p.id === selectedPresetId) ?? presets[0];

  const livePackagePricing = useMemo(() => {
    if (selectionType === "preset" && selectedPreset) {
      return selectedPreset.pricing;
    }
    return computePrice(
      {
        events: customEvents,
        certsPerEvent: customCerts,
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

  const liveTopupPricing = useMemo(
    () => computeTopupPrice(topupCertsAdded, pricingConfig),
    [topupCertsAdded, pricingConfig],
  );

  const soonestCountdown = formatExpiryCountdown(soonestActiveExpiry);

  function openBuyModal(opts?: {
    mode?: "preset" | "custom";
    presetId?: string;
  }) {
    if (opts?.mode) setSelectionType(opts.mode);
    if (opts?.presetId) setSelectedPresetId(opts.presetId);
    setBuyTxRef("");
    setBuyNote("");
    setBuyScreenshot(null);
    setBuyError(null);
    if (buyFileRef.current) buyFileRef.current.value = "";
    setBuyModalOpen(true);
  }

  function openTopupModal(targetEventId?: string) {
    if (targetEventId) {
      setTopupEventId(targetEventId);
    } else if (!topupEventId && events[0]) {
      setTopupEventId(events[0].id);
    }
    setTopupTxRef("");
    setTopupNote("");
    setTopupScreenshot(null);
    setTopupError(null);
    if (topupFileRef.current) topupFileRef.current.value = "";
    setTopupModalOpen(true);
  }

  async function handleSubmitPurchase(e: FormEvent) {
    e.preventDefault();
    setBuyError(null);

    if (buyTxRef.trim().length < 2) {
      setBuyError("Please enter your transaction reference / TID.");
      return;
    }
    if (!buyScreenshot) {
      setBuyError("Please upload your payment receipt screenshot or PDF.");
      return;
    }

    setBuySubmitting(true);
    try {
      const fd = new FormData();
      fd.set("selectionType", selectionType);
      if (selectionType === "preset" && selectedPreset) {
        fd.set("planId", selectedPreset.id);
      } else {
        fd.set("events", String(customEvents));
        fd.set("certsPerEvent", String(customCerts));
        fd.set("months", String(customMonths));
      }
      fd.set("paymentMethod", buyMethod);
      fd.set("transactionReference", buyTxRef.trim());
      fd.set("paymentNote", buyNote.trim());
      fd.set("screenshot", buyScreenshot);

      const res = await fetch("/api/dashboard/billing/purchases", {
        method: "POST",
        body: fd,
      });

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        finalPricePkr?: number;
      };

      if (!res.ok || body.error) {
        setBuyError(body.error || "Failed to submit package purchase.");
        return;
      }

      showToast(
        `Package purchase request (PKR ${(body.finalPricePkr ?? livePackagePricing.finalPricePkr).toLocaleString()}) submitted! Waiting for approval.`,
        "success",
      );
      setBuyModalOpen(false);
      router.refresh();
    } catch {
      setBuyError("Network error while submitting package purchase.");
    } finally {
      setBuySubmitting(false);
    }
  }

  async function handleSubmitTopup(e: FormEvent) {
    e.preventDefault();
    setTopupError(null);

    if (!topupEventId) {
      setTopupError("Please choose an event to top up.");
      return;
    }
    if (topupTxRef.trim().length < 2) {
      setTopupError("Please enter your transaction reference / TID.");
      return;
    }
    if (!topupScreenshot) {
      setTopupError("Please upload your payment receipt screenshot or PDF.");
      return;
    }

    setTopupSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("eventId", topupEventId);
      fd.set("certsAdded", String(topupCertsAdded));
      fd.set("paymentMethod", topupMethod);
      fd.set("transactionReference", topupTxRef.trim());
      fd.set("paymentNote", topupNote.trim());
      fd.set("screenshot", topupScreenshot);

      const res = await fetch("/api/dashboard/billing/topups", {
        method: "POST",
        body: fd,
      });

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        amountPkr?: number;
      };

      if (!res.ok || body.error) {
        setTopupError(body.error || "Failed to submit certificate top-up.");
        return;
      }

      showToast(
        `Top-up request for +${topupCertsAdded} certificates (PKR ${(body.amountPkr ?? liveTopupPricing.amountPkr).toLocaleString()}) submitted!`,
        "success",
      );
      setTopupModalOpen(false);
      router.refresh();
    } catch {
      setTopupError("Network error while submitting certificate top-up.");
    } finally {
      setTopupSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Billing, Packages &amp; Top-Ups
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage event packages, slot balances, and per-event certificate
            top-ups for <strong className="text-slate-900">{org.name}</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isSuperAdmin && (
            <Link
              href="/superadmin/payments"
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-800 hover:bg-indigo-100"
            >
              🛡️ Super-Admin Queue →
            </Link>
          )}
          <Button
            variant="secondary"
            disabled={events.length === 0}
            onClick={() => openTopupModal()}
          >
            + Top up certificates
          </Button>
          <Button onClick={() => openBuyModal({ mode: "preset" })}>
            {purchases.length > 0 ? "Buy another package" : "Buy a package"}
          </Button>
        </div>
      </div>

      {/* Summary Usage Cards ("1 / 3 events", "expires in 41 days") */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Active Event Slots
          </span>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {eventsSlotsUsed} / {eventsSlotsTotal} events
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {eventsSlotsRemaining} slot{eventsSlotsRemaining === 1 ? "" : "s"} left
            across {activePurchases.length} active package
            {activePurchases.length === 1 ? "" : "s"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Next Package Expiry
          </span>
          <p className="mt-2 text-lg font-bold text-slate-900 capitalize">
            {soonestActiveExpiry ? soonestCountdown.label : "No active package"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {soonestActiveExpiry
              ? `Valid until ${formatDate(soonestActiveExpiry)}`
              : pendingPurchases.length > 0
                ? `${pendingPurchases.length} purchase waiting for approval`
                : "Buy a package to create events"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Certificate Top-Up Rate
          </span>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            PKR {pricingConfig.certRatePkr} / cert
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Add extra certificates to any existing event
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Public Retention
          </span>
          <p className="mt-2 text-2xl font-bold text-slate-900">12 months</p>
          <p className="mt-1 text-xs text-slate-500">
            Released certificates stay downloadable for 12 months
          </p>
        </div>
      </section>

      {/* 1. Current Active & Pending Purchases */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Current Packages ({activePurchases.length + pendingPurchases.length})
            </h2>
            <p className="text-xs text-slate-500">
              Creating an event automatically consumes 1 slot from your
              soonest-expiring active package.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openBuyModal({ mode: "custom" })}
          >
            Custom Package Builder
          </Button>
        </div>

        {activePurchases.length === 0 && pendingPurchases.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-semibold text-slate-900">
              No active or pending packages
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Every organization needs an approved package before creating or
              releasing events.
            </p>
            <div className="mt-4">
              <Button onClick={() => openBuyModal({ mode: "preset" })}>
                Buy Your First Package
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {[...activePurchases, ...pendingPurchases].map((p) => {
              const countdown = formatExpiryCountdown(p.expiresAt);
              const pct = Math.min(
                100,
                Math.round((p.eventsUsed / p.eventsTotal) * 100),
              );
              return (
                <div
                  key={p.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold uppercase text-slate-900">
                        {p.kind} Package
                      </span>
                      {p.isPilot && (
                        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold uppercase text-indigo-800">
                          Pilot
                        </span>
                      )}
                    </div>
                    {purchaseStatusBadge(p.effectiveStatus)}
                  </div>

                  <div className="mt-3 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-slate-600">
                      Slots used: {p.eventsUsed} / {p.eventsTotal} events (
                      {p.eventsRemaining} left)
                    </span>
                    <span className="font-mono font-bold text-slate-900">
                      {p.certsPerEvent} certs / event
                    </span>
                  </div>

                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={`h-full rounded-full ${
                        p.eventsRemaining === 0 ? "bg-amber-500" : "bg-indigo-600"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span>
                      {p.effectiveStatus === "pending"
                        ? `Duration: ${p.months} months upon approval`
                        : p.expiresAt
                          ? `${countdown.label} (${formatDate(p.expiresAt)})`
                          : "Active"}
                    </span>
                    <span className="font-mono font-semibold text-slate-800">
                      PKR {p.finalPricePkr.toLocaleString()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. Preset Packages Comparison */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-5">
          <h2 className="text-base font-bold text-slate-900">
            Preset Packages
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Stack multiple packages anytime — unused slots stay active until
            each package&apos;s expiry date.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3.5">Package</th>
                <th className="px-6 py-3.5">Events</th>
                <th className="px-6 py-3.5">Certificates / Event</th>
                <th className="px-6 py-3.5">Validity</th>
                <th className="px-6 py-3.5">Discount</th>
                <th className="px-6 py-3.5">Total Price</th>
                <th className="px-6 py-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
              {presets.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60">
                  <td className="px-6 py-4 font-bold text-slate-900">
                    {p.name}
                  </td>
                  <td className="px-6 py-4">{p.eventsCount}</td>
                  <td className="px-6 py-4">
                    {p.certsPerEvent.toLocaleString()} / event
                  </td>
                  <td className="px-6 py-4">{p.months} months</td>
                  <td className="px-6 py-4 text-emerald-700 font-semibold">
                    {p.pricing.discountPercent > 0
                      ? `${p.pricing.discountPercent}% off`
                      : "—"}
                  </td>
                  <td className="px-6 py-4 font-mono font-bold text-slate-900">
                    PKR {p.pricing.totalPkr.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      onClick={() =>
                        openBuyModal({ mode: "preset", presetId: p.id })
                      }
                    >
                      Buy Package
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Event Certificate Capacities & Quick Top-Up */}
      {events.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="border-b border-slate-100 px-6 py-5">
            <h2 className="text-base font-bold text-slate-900">
              Per-Event Certificate Limits
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Need more certificates on an event? Request a top-up at PKR{" "}
              {pricingConfig.certRatePkr} per certificate.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Event</th>
                  <th className="px-6 py-3">Usage</th>
                  <th className="px-6 py-3">Public Retention</th>
                  <th className="px-6 py-3 text-right">Top Up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {events.map((ev) => {
                  const used = ev.certificatesIssuedCount ?? ev.attendeeCount;
                  return (
                    <tr key={ev.id}>
                      <td className="px-6 py-3.5 font-semibold text-slate-900">
                        <Link
                          href={`/dashboard/events/${ev.id}`}
                          className="hover:text-indigo-600"
                        >
                          {ev.title}
                        </Link>
                      </td>
                      <td className="px-6 py-3.5 font-mono text-xs font-bold text-slate-900">
                        {used} / {ev.maxCertificates} certificates
                      </td>
                      <td className="px-6 py-3.5 text-xs text-slate-500">
                        {ev.released && ev.retentionUntil
                          ? `Until ${formatDate(ev.retentionUntil)}`
                          : "Starts on release (12m)"}
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => openTopupModal(ev.id)}
                        >
                          Top up certificates
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 4. Purchase & Top-Up History */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-5">
          <h2 className="text-base font-bold text-slate-900">
            Purchase &amp; Top-Up History
          </h2>
        </div>

        {purchases.length === 0 && topups.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            No package purchases or top-ups recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Type &amp; Details</th>
                  <th className="px-6 py-3">Amount</th>
                  <th className="px-6 py-3">Payment Proof</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Expiry / Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {purchases.map((p) => (
                  <tr key={`pur-${p.id}`}>
                    <td className="px-6 py-3.5 whitespace-nowrap text-slate-500">
                      {formatDateTime(p.createdAt)}
                    </td>
                    <td className="px-6 py-3.5">
                      <span className="font-bold uppercase text-slate-900">
                        {p.kind} Package
                      </span>
                      {p.isPilot && (
                        <span className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-800">
                          PILOT
                        </span>
                      )}
                      <p className="text-[11px] text-slate-500">
                        {p.eventsUsed}/{p.eventsTotal} events · {p.certsPerEvent}{" "}
                        certs/event · {p.months}m
                      </p>
                    </td>
                    <td className="px-6 py-3.5 font-mono font-semibold text-slate-900">
                      PKR {p.finalPricePkr.toLocaleString()}
                      {p.discountPkr > 0 && (
                        <span className="block text-[10px] text-emerald-600">
                          Saved PKR {p.discountPkr.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3.5">
                      {p.paymentMethod && (
                        <span className="uppercase font-semibold">
                          {p.paymentMethod}
                        </span>
                      )}
                      {p.transactionReference && (
                        <span className="ml-1 font-mono text-slate-500">
                          #{p.transactionReference}
                        </span>
                      )}
                      {p.hasScreenshot && (
                        <a
                          href={`/api/dashboard/billing/payment-requests/${p.id}/screenshot`}
                          target="_blank"
                          rel="noreferrer"
                          className="block font-semibold text-indigo-600 hover:underline"
                        >
                          View Receipt ↗
                        </a>
                      )}
                    </td>
                    <td className="px-6 py-3.5">
                      {purchaseStatusBadge(p.effectiveStatus)}
                    </td>
                    <td className="px-6 py-3.5 text-slate-500">
                      {p.expiresAt ? `Expires ${formatDate(p.expiresAt)}` : "—"}
                      {p.paymentNote ? (
                        <span className="block text-[11px] text-slate-400">
                          {p.paymentNote}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}

                {topups.map((t) => (
                  <tr key={`top-${t.id}`} className="bg-indigo-50/20">
                    <td className="px-6 py-3.5 whitespace-nowrap text-slate-500">
                      {formatDateTime(t.createdAt)}
                    </td>
                    <td className="px-6 py-3.5">
                      <span className="font-bold text-indigo-900">
                        Certificate Top-Up (+{t.certsAdded} certs)
                      </span>
                      <p className="text-[11px] text-slate-500">
                        Event: {t.eventTitle}
                      </p>
                    </td>
                    <td className="px-6 py-3.5 font-mono font-semibold text-slate-900">
                      PKR {t.amountPkr.toLocaleString()}
                    </td>
                    <td className="px-6 py-3.5">
                      {t.paymentMethod && (
                        <span className="uppercase font-semibold">
                          {t.paymentMethod}
                        </span>
                      )}
                      {t.transactionReference && (
                        <span className="ml-1 font-mono text-slate-500">
                          #{t.transactionReference}
                        </span>
                      )}
                      {t.hasScreenshot && (
                        <a
                          href={`/api/dashboard/billing/payment-requests/${t.id}/screenshot`}
                          target="_blank"
                          rel="noreferrer"
                          className="block font-semibold text-indigo-600 hover:underline"
                        >
                          View Receipt ↗
                        </a>
                      )}
                    </td>
                    <td className="px-6 py-3.5">
                      {purchaseStatusBadge(
                        t.status === "approved" ? "active" : t.status,
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-slate-500">
                      {t.paymentNote || "Raises event max_certificates"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* MODAL 1: BUY PACKAGE */}
      <Modal
        open={buyModalOpen}
        onClose={() => !buySubmitting && setBuyModalOpen(false)}
        title="Buy Event Package"
        description="Choose a preset or configure a custom package. Prices are verified on the server from live pricing rules."
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleSubmitPurchase} className="space-y-4">
          {buyError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700">
              {buyError}
            </div>
          )}

          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 text-xs font-bold">
            <button
              type="button"
              onClick={() => setSelectionType("preset")}
              className={`rounded-lg py-2 transition ${
                selectionType === "preset"
                  ? "bg-white text-indigo-700 shadow-2xs"
                  : "text-slate-600"
              }`}
            >
              Preset Packages
            </button>
            <button
              type="button"
              onClick={() => setSelectionType("custom")}
              className={`rounded-lg py-2 transition ${
                selectionType === "custom"
                  ? "bg-white text-indigo-700 shadow-2xs"
                  : "text-slate-600"
              }`}
            >
              Custom Package
            </button>
          </div>

          {selectionType === "preset" ? (
            <div>
              <label
                htmlFor="preset-select"
                className="mb-1.5 block text-xs font-semibold text-slate-700"
              >
                Select Preset Package
              </label>
              <select
                id="preset-select"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                disabled={buySubmitting}
                className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:outline-none"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.eventsCount} event
                    {p.eventsCount === 1 ? "" : "s"}, {p.certsPerEvent}{" "}
                    certs/event, {p.months}m — PKR{" "}
                    {p.pricing.totalPkr.toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="flex justify-between text-xs font-semibold">
                  <span>Events ({pricingConfig.minEvents}–{pricingConfig.maxEvents})</span>
                  <span className="text-indigo-700">{customEvents} events</span>
                </div>
                <input
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
                <div className="flex justify-between text-xs font-semibold">
                  <span>
                    Certificates per event ({pricingConfig.minCertsPerEvent}–
                    {pricingConfig.maxCertsPerEvent}, step {pricingConfig.certsStep})
                  </span>
                  <span className="text-indigo-700">{customCerts} certs</span>
                </div>
                <input
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
                  Validity Duration
                </span>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {pricingConfig.durationMultipliers.map((d) => (
                    <button
                      key={d.months}
                      type="button"
                      onClick={() => setCustomMonths(d.months)}
                      className={`rounded-lg border py-1.5 text-xs font-bold ${
                        customMonths === d.months
                          ? "border-indigo-600 bg-white text-indigo-700"
                          : "border-slate-200 bg-white/70 text-slate-600"
                      }`}
                    >
                      {d.months} months ({d.mult}×)
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Computed Breakdown Box */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3.5 text-xs text-indigo-950">
            <div className="flex items-baseline justify-between">
              <span className="font-bold">Amount to Send:</span>
              <span className="font-mono text-lg font-extrabold text-indigo-700">
                PKR {livePackagePricing.finalPricePkr.toLocaleString()}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-indigo-900">
              {livePackagePricing.events} × PKR{" "}
              {livePackagePricing.perEventPricePkr.toLocaleString()}/event
              {livePackagePricing.discountPercent > 0
                ? ` · ${livePackagePricing.discountPercent}% multi-event discount`
                : ""}{" "}
              · {livePackagePricing.months} months ({livePackagePricing.durationMultiplier}×)
            </p>
            <p className="mt-2 text-[11px] text-indigo-800">
              {METHOD_META[buyMethod].instructions}
            </p>
          </div>

          {/* Payment Method */}
          <div className="grid grid-cols-3 gap-2">
            {(["bank", "jazzcash", "easypaisa"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setBuyMethod(m)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  buyMethod === m
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                {m === "bank"
                  ? "Bank Transfer"
                  : m === "jazzcash"
                    ? "JazzCash"
                    : "Easypaisa"}
              </button>
            ))}
          </div>

          <Input
            label="Transaction Reference / TID *"
            placeholder="e.g. 084920194821 or STAN-449102"
            value={buyTxRef}
            onChange={(e) => setBuyTxRef(e.target.value)}
            required
            disabled={buySubmitting}
          />

          <Input
            label="Optional Payment Note"
            placeholder="e.g. Sent from HBL account ending 4812"
            value={buyNote}
            onChange={(e) => setBuyNote(e.target.value)}
            disabled={buySubmitting}
          />

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Payment Receipt Screenshot (PNG, JPG, WebP, or PDF — max 5 MB) *
            </label>
            <input
              ref={buyFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              required
              disabled={buySubmitting}
              onChange={(e) => setBuyScreenshot(e.target.files?.[0] ?? null)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setBuyModalOpen(false)}
              disabled={buySubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={buySubmitting}>
              Submit Package Purchase
            </Button>
          </div>
        </form>
      </Modal>

      {/* MODAL 2: CERTIFICATE TOP-UP */}
      <Modal
        open={topupModalOpen}
        onClose={() => !topupSubmitting && setTopupModalOpen(false)}
        title="Top Up Event Certificates"
        description={`Request extra certificates for an existing event at PKR ${pricingConfig.certRatePkr} per certificate.`}
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSubmitTopup} className="space-y-4">
          {topupError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700">
              {topupError}
            </div>
          )}

          <div>
            <label
              htmlFor="topup-event"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Select Event *
            </label>
            <select
              id="topup-event"
              value={topupEventId}
              onChange={(e) => setTopupEventId(e.target.value)}
              disabled={topupSubmitting}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
            >
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.title} (current cap: {ev.maxCertificates} certificates)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Additional Certificates (increments of {pricingConfig.certsStep})
            </label>
            <div className="grid grid-cols-5 gap-2">
              {[25, 50, 100, 250, 500].map((qty) => (
                <button
                  key={qty}
                  type="button"
                  onClick={() => setTopupCertsAdded(qty)}
                  className={`rounded-lg border py-2 text-xs font-bold ${
                    topupCertsAdded === qty
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  +{qty}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3.5 text-xs text-indigo-950">
            <div className="flex items-baseline justify-between">
              <span className="font-bold">
                +{liveTopupPricing.certsAdded} certificates × PKR{" "}
                {liveTopupPricing.certRatePkr}:
              </span>
              <span className="font-mono text-lg font-extrabold text-indigo-700">
                PKR {liveTopupPricing.amountPkr.toLocaleString()}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-indigo-800">
              {METHOD_META[topupMethod].instructions}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(["bank", "jazzcash", "easypaisa"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setTopupMethod(m)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  topupMethod === m
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                {m === "bank"
                  ? "Bank Transfer"
                  : m === "jazzcash"
                    ? "JazzCash"
                    : "Easypaisa"}
              </button>
            ))}
          </div>

          <Input
            label="Transaction Reference / TID *"
            placeholder="e.g. 084920194821"
            value={topupTxRef}
            onChange={(e) => setTopupTxRef(e.target.value)}
            required
            disabled={topupSubmitting}
          />

          <Input
            label="Optional Note"
            placeholder="e.g. Extra speaker & attendee registrations"
            value={topupNote}
            onChange={(e) => setTopupNote(e.target.value)}
            disabled={topupSubmitting}
          />

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Payment Receipt Screenshot *
            </label>
            <input
              ref={topupFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              required
              disabled={topupSubmitting}
              onChange={(e) => setTopupScreenshot(e.target.files?.[0] ?? null)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setTopupModalOpen(false)}
              disabled={topupSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={topupSubmitting}>
              Submit Top-Up Request
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
