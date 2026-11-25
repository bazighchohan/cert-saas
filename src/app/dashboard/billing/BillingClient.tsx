"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import type {
  BillingDashboardData,
  PaymentMethod,
  PaymentRequestRow,
  PlanDetails,
} from "@/lib/dashboard-data";
import { reviewPaymentRequestAction } from "./actions";

const METHOD_META: Record<
  PaymentMethod,
  { label: string; instructions: string }
> = {
  bank: {
    label: "Bank Transfer (IBFT / Raast)",
    instructions:
      "Send the exact PKR plan amount via IBFT / Raast to your designated billing bank account, save the transfer receipt, and enter the Bank Reference / STAN number below.",
  },
  jazzcash: {
    label: "JazzCash",
    instructions:
      "Send the exact PKR plan amount to our JazzCash merchant / wallet account, capture the confirmation screen, and enter the 11–12 digit TID below.",
  },
  easypaisa: {
    label: "Easypaisa",
    instructions:
      "Send the exact PKR plan amount to our Easypaisa account, save the receipt screenshot, and enter the Transaction ID (TID) below.",
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

function meterPercentage(used: number, max: number | null): number {
  if (max === null || max <= 0) return 12; // subtle bar for unlimited
  return Math.min(100, Math.round((used / max) * 100));
}

function statusBadge(status: PaymentRequestRow["status"]) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
        ✓ Approved
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">
        ✕ Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
      ⏳ Pending Review
    </span>
  );
}

export default function BillingClient({
  data,
}: {
  data: BillingDashboardData;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const {
    org,
    plan,
    eventsUsed,
    certificatesUsed,
    allPlans,
    paymentRequests,
    isSuperAdmin,
    adminPendingRequests,
  } = data;

  const paidPlans = allPlans.filter((p) => p.pricePkr > 0);
  const defaultUpgradePlan =
    paidPlans.find((p) => p.id !== plan.id) ?? paidPlans[0] ?? null;

  // Upgrade Request Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    defaultUpgradePlan?.id ?? "starter",
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("bank");
  const [transactionReference, setTransactionReference] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Super-admin review state
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  const selectedPlan: PlanDetails | undefined =
    paidPlans.find((p) => p.id === selectedPlanId) ?? paidPlans[0];

  const hasPendingRequest = paymentRequests.some((r) => r.status === "pending");

  function openUpgradeModal(targetPlanId?: string) {
    if (targetPlanId && paidPlans.some((p) => p.id === targetPlanId)) {
      setSelectedPlanId(targetPlanId);
    } else if (defaultUpgradePlan) {
      setSelectedPlanId(defaultUpgradePlan.id);
    }
    setTransactionReference("");
    setScreenshotFile(null);
    setFormError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setModalOpen(true);
  }

  async function handleSubmitUpgrade(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!selectedPlan) {
      setFormError("Please select a paid plan.");
      return;
    }
    if (transactionReference.trim().length < 2) {
      setFormError("Please enter your transaction reference / TID.");
      return;
    }
    if (!screenshotFile) {
      setFormError("Please attach a screenshot or PDF of your payment receipt.");
      return;
    }

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("planId", selectedPlan.id);
      fd.set("paymentMethod", paymentMethod);
      fd.set("transactionReference", transactionReference.trim());
      fd.set("screenshot", screenshotFile);

      const res = await fetch("/api/dashboard/billing/payment-requests", {
        method: "POST",
        body: fd,
      });

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!res.ok || body.error) {
        setFormError(body.error || "Failed to submit upgrade request.");
        return;
      }

      showToast(
        `Upgrade request for ${selectedPlan.name} (PKR ${selectedPlan.pricePkr.toLocaleString()}) submitted! Your plan will upgrade automatically once approved.`,
        "success",
      );
      setModalOpen(false);
      router.refresh();
    } catch {
      setFormError("Network error while submitting payment request.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdminDecision(
    requestId: string,
    decision: "approved" | "rejected",
  ) {
    setReviewingId(requestId);
    try {
      const res = await reviewPaymentRequestAction({
        requestId,
        decision,
        reviewerNote: reviewNotes[requestId] ?? "",
        billingDays: 30,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        decision === "approved"
          ? "Payment request approved — organization plan upgraded for 30 days."
          : "Payment request marked as rejected.",
        "success",
      );
      router.refresh();
    } catch {
      showToast("Failed to update payment request.", "error");
    } finally {
      setReviewingId(null);
    }
  }

  const eventsPct = meterPercentage(eventsUsed, plan.maxEvents);
  const certsPct = meterPercentage(certificatesUsed, plan.maxCertificatesTotal);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Billing &amp; Plans
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Subscription, usage meters, and manual payment upgrades for{" "}
            <strong className="text-slate-900">{org.name}</strong>.
          </p>
        </div>

        {paidPlans.length > 0 && (
          <Button onClick={() => openUpgradeModal()}>
            {org.isReadOnly ? "Renew / Request Upgrade" : "Request Upgrade"}
          </Button>
        )}
      </div>

      {/* Read-only / Expiring-soon status banner */}
      {org.isReadOnly && (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-900 shadow-xs"
        >
          <p className="font-bold">
            Read-Only Mode — Your {plan.name} plan expired on{" "}
            {formatDate(org.planExpiresAt)}
          </p>
          <p className="mt-1 text-xs text-red-800">
            You can still view all events and export attendee &amp; download
            reports, and <strong>public certificate downloads for released events remain active</strong>.
            Submit a renewal/upgrade payment request below to unlock creating and editing resources.
          </p>
        </div>
      )}

      {!org.isReadOnly && org.planExpiringSoon && org.planExpiresAt && (
        <div
          role="status"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-xs"
        >
          <p className="font-bold">
            Plan Expiring Soon — Renews by {formatDate(org.planExpiresAt)}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Submit a renewal payment request before expiration to avoid entering
            dashboard read-only mode.
          </p>
        </div>
      )}

      {/* 1. Current Plan & Usage Meters */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                Current Plan: {plan.name}
              </span>
              {org.isReadOnly ? (
                <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800">
                  Expired (Read-Only)
                </span>
              ) : org.planExpiresAt ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                  Valid until {formatDate(org.planExpiresAt)}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                  No expiration
                </span>
              )}
            </div>

            <h2 className="mt-3 text-2xl font-bold text-slate-900">
              {plan.pricePkr === 0
                ? "PKR 0 / month"
                : `PKR ${plan.pricePkr.toLocaleString()} / 30 days`}
            </h2>
          </div>

          {hasPendingRequest && (
            <span className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900">
              ⏳ Upgrade payment request pending verification
            </span>
          )}
        </div>

        {/* Usage Meters */}
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {/* Events meter */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-slate-600">
                Events Created
              </span>
              <span className="text-sm font-bold text-slate-900">
                {eventsUsed} / {plan.maxEvents ?? "∞"}
              </span>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full transition-all ${
                  plan.maxEvents !== null && eventsUsed >= plan.maxEvents
                    ? "bg-amber-500"
                    : "bg-indigo-600"
                }`}
                style={{ width: `${eventsPct}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              {plan.maxEvents === null
                ? "Unlimited events"
                : `${Math.max(0, plan.maxEvents - eventsUsed)} remaining`}
            </p>
          </div>

          {/* Total Certificates meter */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-slate-600">
                Total Certificates
              </span>
              <span className="text-sm font-bold text-slate-900">
                {certificatesUsed.toLocaleString()} /{" "}
                {plan.maxCertificatesTotal !== null
                  ? plan.maxCertificatesTotal.toLocaleString()
                  : "∞"}
              </span>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full rounded-full transition-all ${
                  plan.maxCertificatesTotal !== null &&
                  certificatesUsed >= plan.maxCertificatesTotal
                    ? "bg-amber-500"
                    : "bg-indigo-600"
                }`}
                style={{ width: `${certsPct}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              {plan.maxCertificatesTotal === null
                ? "Unlimited across events"
                : `${Math.max(
                    0,
                    plan.maxCertificatesTotal - certificatesUsed,
                  ).toLocaleString()} remaining`}
            </p>
          </div>

          {/* Per-event cap */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <span className="text-xs font-semibold text-slate-600">
              Per-Event Cap
            </span>
            <p className="mt-2 text-lg font-bold text-slate-900">
              {plan.maxCertificatesPerEvent !== null
                ? `${plan.maxCertificatesPerEvent.toLocaleString()} / event`
                : "Unlimited"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Max attendees &amp; certificates per event
            </p>
          </div>

          {/* Certificate types & branding */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <span className="text-xs font-semibold text-slate-600">
              Types &amp; Branding
            </span>
            <p className="mt-2 text-lg font-bold text-slate-900">
              {plan.maxCertificateTypesPerEvent !== null
                ? `${plan.maxCertificateTypesPerEvent} types / event`
                : "Unlimited types"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Custom branding:{" "}
              <strong>{plan.allowCustomBranding ? "Included" : "No"}</strong>
            </p>
          </div>
        </div>
      </section>

      {/* 2. Plan Comparison Table */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-5">
          <h2 className="text-base font-bold text-slate-900">
            Compare Plans
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Pay via Bank Transfer, JazzCash, or Easypaisa — no credit card required.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3.5">Plan</th>
                <th className="px-6 py-3.5">Price (30 Days)</th>
                <th className="px-6 py-3.5">Max Events</th>
                <th className="px-6 py-3.5">Certificates / Event</th>
                <th className="px-6 py-3.5">Total Certificates</th>
                <th className="px-6 py-3.5">Types / Event</th>
                <th className="px-6 py-3.5">Custom Branding</th>
                <th className="px-6 py-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
              {allPlans.map((p) => {
                const isCurrent = p.id === plan.id && !org.isReadOnly;
                const isExpiredCurrent = p.id === plan.id && org.isReadOnly;
                return (
                  <tr
                    key={p.id}
                    className={
                      p.id === plan.id ? "bg-indigo-50/35" : "hover:bg-slate-50/60"
                    }
                  >
                    <td className="px-6 py-4 font-bold text-slate-900">
                      <span>{p.name}</span>
                      {p.id === plan.id && (
                        <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-indigo-700">
                          Current
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      {p.pricePkr === 0
                        ? "Free"
                        : `PKR ${p.pricePkr.toLocaleString()}`}
                    </td>
                    <td className="px-6 py-4">
                      {p.maxEvents !== null ? p.maxEvents : "Unlimited"}
                    </td>
                    <td className="px-6 py-4">
                      {p.maxCertificatesPerEvent !== null
                        ? p.maxCertificatesPerEvent.toLocaleString()
                        : "Unlimited"}
                    </td>
                    <td className="px-6 py-4">
                      {p.maxCertificatesTotal !== null
                        ? p.maxCertificatesTotal.toLocaleString()
                        : "Unlimited"}
                    </td>
                    <td className="px-6 py-4">
                      {p.maxCertificateTypesPerEvent !== null
                        ? p.maxCertificateTypesPerEvent
                        : "Unlimited"}
                    </td>
                    <td className="px-6 py-4">
                      {p.allowCustomBranding ? "✓ Yes" : "—"}
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      {p.pricePkr === 0 ? (
                        <span className="text-xs font-medium text-slate-400">
                          {isCurrent ? "Active" : "Starter tier"}
                        </span>
                      ) : isExpiredCurrent ? (
                        <Button
                          size="sm"
                          onClick={() => openUpgradeModal(p.id)}
                        >
                          Renew {p.name}
                        </Button>
                      ) : isCurrent ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openUpgradeModal(p.id)}
                        >
                          Extend +30d
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => openUpgradeModal(p.id)}
                        >
                          Request Upgrade
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Organization's Payment Request History */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-5">
          <h2 className="text-base font-bold text-slate-900">
            Payment Upgrade Requests
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            History of submitted Bank / JazzCash / Easypaisa payment receipts for{" "}
            {org.name}.
          </p>
        </div>

        {paymentRequests.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            No upgrade requests submitted yet. Click{" "}
            <strong>Request Upgrade</strong> above to submit a payment receipt.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Submitted</th>
                  <th className="px-6 py-3">Plan</th>
                  <th className="px-6 py-3">Amount</th>
                  <th className="px-6 py-3">Method &amp; Reference</th>
                  <th className="px-6 py-3">Receipt</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {paymentRequests.map((req) => (
                  <tr key={req.id} className="hover:bg-slate-50/60">
                    <td className="px-6 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                      {formatDateTime(req.createdAt)}
                    </td>
                    <td className="px-6 py-3.5 font-semibold text-slate-900">
                      {req.planName}
                    </td>
                    <td className="px-6 py-3.5 font-mono text-xs font-semibold text-slate-900">
                      PKR {req.amountPkr.toLocaleString()}
                    </td>
                    <td className="px-6 py-3.5 text-xs">
                      <span className="font-semibold uppercase text-slate-800">
                        {req.paymentMethod}
                      </span>
                      <span className="ml-2 font-mono text-slate-500">
                        #{req.transactionReference}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-xs">
                      {req.hasScreenshot ? (
                        <a
                          href={`/api/dashboard/billing/payment-requests/${req.id}/screenshot`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-indigo-600 hover:underline"
                        >
                          View Screenshot ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-6 py-3.5">{statusBadge(req.status)}</td>
                    <td className="px-6 py-3.5 text-xs text-slate-600">
                      {req.reviewerNote || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Platform Super-Admin Verification Queue (only visible to public.super_admins) */}
      {isSuperAdmin && (
        <section className="overflow-hidden rounded-2xl border-2 border-indigo-200 bg-white shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 bg-indigo-50/60 px-6 py-4">
            <div>
              <h2 className="text-sm font-bold text-indigo-950 sm:text-base">
                🛡️ Platform Super-Admin: Pending Upgrade Approvals (
                {adminPendingRequests.length})
              </h2>
              <p className="mt-0.5 text-xs text-indigo-800">
                Approving a request atomically updates{" "}
                <code className="font-mono">organizations.plan_id</code> and extends{" "}
                <code className="font-mono">plan_expires_at</code> by 30 days.
              </p>
            </div>
            <a
              href="/superadmin/payments"
              className="rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Open /superadmin Console →
            </a>
          </div>

          {adminPendingRequests.length === 0 ? (
            <div className="px-6 py-8 text-center text-xs text-slate-500">
              No pending payment requests across any organization.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {adminPendingRequests.map((req) => (
                <div
                  key={req.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-6 py-4"
                >
                  <div className="space-y-1 text-xs">
                    <p className="text-sm font-bold text-slate-900">
                      {req.orgName || req.orgId} → {req.planName} (PKR{" "}
                      {req.amountPkr.toLocaleString()})
                    </p>
                    <p className="text-slate-600">
                      Method:{" "}
                      <strong className="uppercase">{req.paymentMethod}</strong>{" "}
                      · Ref:{" "}
                      <code className="font-mono font-semibold">
                        {req.transactionReference}
                      </code>{" "}
                      · {formatDateTime(req.createdAt)}
                    </p>
                    {req.hasScreenshot && (
                      <a
                        href={`/api/dashboard/billing/payment-requests/${req.id}/screenshot`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block font-semibold text-indigo-600 hover:underline"
                      >
                        Inspect Payment Receipt ↗
                      </a>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      placeholder="Optional reviewer note..."
                      value={reviewNotes[req.id] ?? ""}
                      onChange={(e) =>
                        setReviewNotes((prev) => ({
                          ...prev,
                          [req.id]: e.target.value,
                        }))
                      }
                      className="w-48 rounded-xl border border-slate-300 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                    />
                    <Button
                      size="sm"
                      loading={reviewingId === req.id}
                      onClick={() => void handleAdminDecision(req.id, "approved")}
                    >
                      Approve (+30d)
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={reviewingId === req.id}
                      onClick={() => void handleAdminDecision(req.id, "rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Request Upgrade Modal */}
      <Modal
        open={modalOpen}
        onClose={() => !submitting && setModalOpen(false)}
        title="Request Plan Upgrade"
        description="Submit your manual payment details and screenshot. Once verified, your organization plan upgrades automatically."
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSubmitUpgrade} className="space-y-4">
          {formError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700">
              {formError}
            </div>
          )}

          {/* Target Plan */}
          <div>
            <label
              htmlFor="upgrade-plan"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Select Plan
            </label>
            <select
              id="upgrade-plan"
              value={selectedPlanId}
              onChange={(e) => setSelectedPlanId(e.target.value)}
              disabled={submitting}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {paidPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — PKR {p.pricePkr.toLocaleString()} / 30 days (
                  {p.maxEvents !== null ? `${p.maxEvents} events` : "Unlimited events"}
                  ,{" "}
                  {p.maxCertificatesPerEvent !== null
                    ? `${p.maxCertificatesPerEvent.toLocaleString()} certs/event`
                    : "Unlimited certs"}
                  )
                </option>
              ))}
            </select>
          </div>

          {/* Payment Method */}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-700">
              Payment Method
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(["bank", "jazzcash", "easypaisa"] as const).map((m) => {
                const active = paymentMethod === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={submitting}
                    onClick={() => setPaymentMethod(m)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold capitalize transition ${
                      active
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-600"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {m === "bank"
                      ? "Bank Transfer"
                      : m === "jazzcash"
                        ? "JazzCash"
                        : "Easypaisa"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Amount + Instructions */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3.5 text-xs text-indigo-950">
            <p className="font-bold">
              Amount to Send: PKR{" "}
              {(selectedPlan?.pricePkr ?? 0).toLocaleString()}
            </p>
            <p className="mt-1 text-indigo-900">
              {METHOD_META[paymentMethod].instructions}
            </p>
          </div>

          {/* Transaction Reference */}
          <Input
            label="Transaction Reference / TID"
            placeholder="e.g. 084920194821 or STAN-449102"
            value={transactionReference}
            onChange={(e) => setTransactionReference(e.target.value)}
            required
            disabled={submitting}
          />

          {/* Receipt Screenshot Upload */}
          <div>
            <label
              htmlFor="payment-screenshot"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Payment Receipt Screenshot (PNG, JPG, WebP, or PDF — max 5 MB)
            </label>
            <input
              ref={fileInputRef}
              id="payment-screenshot"
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              disabled={submitting}
              onChange={(e) => setScreenshotFile(e.target.files?.[0] ?? null)}
              required
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={() => setModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={submitting}>
              Submit Upgrade Request
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
