"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, useToast } from "@/components/ui";
import { isPlanExpired } from "@/lib/plan-enforcement-helpers";
import type { SuperAdminOrgDetailData } from "@/lib/superadmin-data";
import {
  changeOrganizationPlanManuallyAction,
  extendOrganizationExpiryAction,
  setOrganizationSuspendedAction,
  superAdminReviewPaymentAction,
} from "../../actions";

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

export default function OrganizationDetailClient({
  data,
}: {
  data: SuperAdminOrgDetailData;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const {
    org,
    currentPlan,
    allPlans,
    usage,
    members,
    events,
    paymentRequests,
    auditLogs,
  } = data;

  // Suspend / Unsuspend state
  const [suspendReason, setSuspendReason] = useState("");
  const [togglingSuspend, setTogglingSuspend] = useState(false);

  // Manual Plan Change state
  const [selectedPlanId, setSelectedPlanId] = useState(org.planId);
  const [planDurationDays, setPlanDurationDays] = useState("30");
  const [planReason, setPlanReason] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);

  // Extend Expiry state
  const [exactExpiryDate, setExactExpiryDate] = useState("");
  const [expiryReason, setExpiryReason] = useState("");
  const [savingExpiry, setSavingExpiry] = useState(false);

  // Payment review state
  const [reviewingPaymentId, setReviewingPaymentId] = useState<string | null>(
    null,
  );

  const expired = isPlanExpired(org.planExpiresAt);

  async function handleToggleSuspend() {
    const nextSuspended = org.status === "active";
    setTogglingSuspend(true);
    try {
      const res = await setOrganizationSuspendedAction({
        orgId: org.id,
        suspended: nextSuspended,
        reason: suspendReason,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        nextSuspended
          ? `Suspended "${org.name}" — admins and public pages blocked at once.`
          : `Unsuspended "${org.name}" — access restored.`,
        "success",
      );
      setSuspendReason("");
      router.refresh();
    } catch {
      showToast("Failed to update organization status.", "error");
    } finally {
      setTogglingSuspend(false);
    }
  }

  async function handleManualPlanSubmit(e: FormEvent) {
    e.preventDefault();
    setSavingPlan(true);
    try {
      const days =
        selectedPlanId === "free"
          ? null
          : Math.max(1, Number(planDurationDays) || 30);
      const res = await changeOrganizationPlanManuallyAction({
        orgId: org.id,
        planId: selectedPlanId,
        durationDays: days,
        reason: planReason,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(`Updated plan to "${selectedPlanId}" and logged to audit_log.`, "success");
      setPlanReason("");
      router.refresh();
    } catch {
      showToast("Failed to change plan.", "error");
    } finally {
      setSavingPlan(false);
    }
  }

  async function handleQuickExtend(addDays: number) {
    setSavingExpiry(true);
    try {
      const res = await extendOrganizationExpiryAction({
        orgId: org.id,
        addDays,
        reason: expiryReason || `Extended by +${addDays} days`,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(`Extended plan expiration by +${addDays} days.`, "success");
      router.refresh();
    } catch {
      showToast("Failed to extend expiration.", "error");
    } finally {
      setSavingExpiry(false);
    }
  }

  async function handleSetExactExpiry(e: FormEvent) {
    e.preventDefault();
    if (!exactExpiryDate) return;
    setSavingExpiry(true);
    try {
      const res = await extendOrganizationExpiryAction({
        orgId: org.id,
        exactDate: exactExpiryDate,
        reason: expiryReason || `Set expiration date to ${exactExpiryDate}`,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(`Updated expiration date to ${exactExpiryDate}.`, "success");
      router.refresh();
    } catch {
      showToast("Failed to update expiration date.", "error");
    } finally {
      setSavingExpiry(false);
    }
  }

  async function handleDecision(
    requestId: string,
    decision: "approved" | "rejected",
  ) {
    setReviewingPaymentId(requestId);
    try {
      const res = await superAdminReviewPaymentAction({
        requestId,
        decision,
        billingDays: 30,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        decision === "approved"
          ? "Payment request approved — plan upgraded."
          : "Payment request rejected.",
        "success",
      );
      router.refresh();
    } catch {
      showToast("Failed to review payment request.", "error");
    } finally {
      setReviewingPaymentId(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb & Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/superadmin/organizations"
            className="text-xs font-semibold text-indigo-600 hover:underline"
          >
            ← Back to Organizations
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold text-slate-900">{org.name}</h1>
            <span className="font-mono text-xs text-slate-500">/{org.slug}</span>
            {org.status === "active" ? (
              <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                Active
              </span>
            ) : (
              <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800 ring-1 ring-red-200">
                Suspended
              </span>
            )}
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold uppercase text-indigo-700 ring-1 ring-indigo-200">
              {currentPlan.name} Plan
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-slate-500">
            org_id: {org.id} · Created {formatDateTime(org.createdAt)}
          </p>
        </div>
      </div>

      {/* 1. Usage Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Events
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {usage.eventsCount} / {currentPlan.maxEvents ?? "∞"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Attendees
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {usage.attendeesCount.toLocaleString()}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Certificates Issued
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {usage.certificatesIssuedCount.toLocaleString()} /{" "}
            {currentPlan.maxCertificatesTotal !== null
              ? currentPlan.maxCertificatesTotal.toLocaleString()
              : "∞"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Plan Expiry
          </p>
          <p
            className={`mt-2 text-base font-bold ${
              expired ? "text-red-700" : "text-slate-900"
            }`}
          >
            {org.planExpiresAt
              ? new Date(org.planExpiresAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "No expiration"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {usage.downloadsCount.toLocaleString()} total PDF downloads
          </p>
        </div>
      </div>

      {/* 2. Governance Controls: Change Plan, Extend Expiry, Suspend/Unsuspend */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Manual Plan Change */}
        <form
          onSubmit={handleManualPlanSubmit}
          className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs"
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              Change Plan Manually
            </h2>
            <p className="text-xs text-slate-500">
              Writes <code className="font-mono">superadmin.plan_changed</code>{" "}
              to <code className="font-mono">audit_log</code>.
            </p>
          </div>

          <div>
            <label
              htmlFor="manual-plan-select"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Target Plan
            </label>
            <select
              id="manual-plan-select"
              value={selectedPlanId}
              onChange={(e) => setSelectedPlanId(e.target.value)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {allPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (PKR {p.pricePkr.toLocaleString()})
                </option>
              ))}
            </select>
          </div>

          {selectedPlanId !== "free" && (
            <Input
              label="Active Duration (Days)"
              type="number"
              min={1}
              max={3660}
              value={planDurationDays}
              onChange={(e) => setPlanDurationDays(e.target.value)}
            />
          )}

          <Input
            label="Audit Reason (Optional)"
            placeholder="e.g. Sponsored university partnership"
            value={planReason}
            onChange={(e) => setPlanReason(e.target.value)}
          />

          <Button type="submit" size="sm" loading={savingPlan}>
            Save Plan Change
          </Button>
        </form>

        {/* Extend Expiry */}
        <form
          onSubmit={handleSetExactExpiry}
          className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs"
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900">Extend Expiry</h2>
            <p className="text-xs text-slate-500">
              Current:{" "}
              <strong>
                {org.planExpiresAt
                  ? formatDateTime(org.planExpiresAt)
                  : "None (non-expiring)"}
              </strong>
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {[7, 30, 90, 365].map((d) => (
              <Button
                key={d}
                type="button"
                variant="secondary"
                size="sm"
                disabled={savingExpiry}
                onClick={() => void handleQuickExtend(d)}
              >
                +{d}d
              </Button>
            ))}
          </div>

          <Input
            label="Or Set Exact Expiry Date (UTC)"
            type="date"
            value={exactExpiryDate}
            onChange={(e) => setExactExpiryDate(e.target.value)}
          />

          <Input
            label="Reason (Optional)"
            placeholder="e.g. Goodwill extension"
            value={expiryReason}
            onChange={(e) => setExpiryReason(e.target.value)}
          />

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={savingExpiry}
            disabled={!exactExpiryDate}
          >
            Set Exact Date
          </Button>
        </form>

        {/* Suspend / Unsuspend */}
        <div
          className={`space-y-4 rounded-2xl border p-6 shadow-xs ${
            org.status === "suspended"
              ? "border-red-300 bg-red-50/40"
              : "border-slate-200 bg-white"
          }`}
        >
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              {org.status === "active"
                ? "Suspend Organization"
                : "Organization is Suspended"}
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              {org.status === "active"
                ? "Suspending revokes member logins, blocks dashboard access via RLS & server guards, and marks all public /e/[slug] pages unavailable immediately."
                : "Admins are currently blocked from signing in and public event pages show unavailable."}
            </p>
          </div>

          <Input
            label="Audit Note / Reason"
            placeholder={
              org.status === "active"
                ? "e.g. Abuse report / unpaid chargeback"
                : "e.g. Issue resolved"
            }
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
          />

          <Button
            variant={org.status === "active" ? "danger" : "primary"}
            size="sm"
            loading={togglingSuspend}
            onClick={() => void handleToggleSuspend()}
          >
            {org.status === "active"
              ? "Suspend Organization Now"
              : "Unsuspend Organization"}
          </Button>
        </div>
      </div>

      {/* 3. Organization Members (Read-Only — Impersonation Prohibited) */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Members ({members.length})
            </h2>
            <p className="text-xs text-slate-500">
              Organization owners &amp; admins. User impersonation is strictly
              disabled.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600">
            🔒 Impersonation Disabled
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3">Email</th>
                <th className="px-6 py-3">User ID</th>
                <th className="px-6 py-3">Role</th>
                <th className="px-6 py-3">Joined</th>
                <th className="px-6 py-3">Last Login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="px-6 py-3 font-semibold text-slate-900">
                    {m.email ?? "—"}
                  </td>
                  <td className="px-6 py-3 font-mono text-[11px] text-slate-500">
                    {m.userId}
                  </td>
                  <td className="px-6 py-3 capitalize">{m.role}</td>
                  <td className="px-6 py-3 text-slate-500">
                    {formatDateTime(m.joinedAt)}
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {m.lastSignInAt ? formatDateTime(m.lastSignInAt) : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Events Table */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-bold text-slate-900">
            Events ({events.length})
          </h2>
        </div>

        {events.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-slate-500">
            This organization has not created any events yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Title</th>
                  <th className="px-6 py-3">Public URL</th>
                  <th className="px-6 py-3">Portal State</th>
                  <th className="px-6 py-3 text-right">Attendees</th>
                  <th className="px-6 py-3 text-right">Certificates</th>
                  <th className="px-6 py-3 text-right">Downloads</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td className="px-6 py-3 font-semibold text-slate-900">
                      {ev.title}
                    </td>
                    <td className="px-6 py-3 font-mono text-indigo-600">
                      <a
                        href={`/e/${ev.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        /e/{ev.slug} ↗
                      </a>
                    </td>
                    <td className="px-6 py-3">
                      {org.status === "suspended" ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
                          Unavailable (Org Suspended)
                        </span>
                      ) : ev.released ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Released
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          Draft
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right font-mono">
                      {ev.attendeeCount.toLocaleString()}
                    </td>
                    <td className="px-6 py-3 text-right font-mono">
                      {ev.certificatesIssuedCount.toLocaleString()}
                    </td>
                    <td className="px-6 py-3 text-right font-mono">
                      {ev.downloadsCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Organization Payment Requests */}
      {paymentRequests.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="border-b border-slate-100 px-6 py-4">
            <h2 className="text-base font-bold text-slate-900">
              Payment Requests ({paymentRequests.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Plan &amp; Amount</th>
                  <th className="px-6 py-3">Method &amp; Ref</th>
                  <th className="px-6 py-3">Proof</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {paymentRequests.map((req) => (
                  <tr key={req.id}>
                    <td className="px-6 py-3 whitespace-nowrap text-slate-500">
                      {formatDateTime(req.createdAt)}
                    </td>
                    <td className="px-6 py-3 font-semibold text-slate-900">
                      {req.planName} · PKR {req.amountPkr.toLocaleString()}
                    </td>
                    <td className="px-6 py-3">
                      <span className="font-semibold uppercase">
                        {req.paymentMethod}
                      </span>{" "}
                      ·{" "}
                      <code className="font-mono text-slate-500">
                        {req.transactionReference}
                      </code>
                    </td>
                    <td className="px-6 py-3">
                      {req.hasScreenshot ? (
                        <a
                          href={`/api/superadmin/payment-requests/${req.id}/screenshot`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-indigo-600 hover:underline"
                        >
                          View Proof ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-6 py-3 capitalize font-semibold">
                      {req.status}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {req.status === "pending" && (
                        <div className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            loading={reviewingPaymentId === req.id}
                            onClick={() =>
                              void handleDecision(req.id, "approved")
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={reviewingPaymentId === req.id}
                            onClick={() =>
                              void handleDecision(req.id, "rejected")
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 6. Organization Audit Log */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-bold text-slate-900">
            Audit Log ({auditLogs.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3">Timestamp</th>
                <th className="px-6 py-3">Action</th>
                <th className="px-6 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
              {auditLogs.map((l) => (
                <tr key={l.id}>
                  <td className="px-6 py-2.5 whitespace-nowrap text-slate-500">
                    {formatDateTime(l.createdAt)}
                  </td>
                  <td className="px-6 py-2.5 font-mono font-semibold text-slate-900">
                    {l.action}
                  </td>
                  <td className="max-w-xl truncate px-6 py-2.5 font-mono text-[11px] text-slate-500">
                    {JSON.stringify(l.details)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
