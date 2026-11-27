"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Modal, useToast } from "@/components/ui";
import type { PlatformFeatureFlags } from "@/lib/feature-flags";
import type { SignupRequestQueueRow } from "@/lib/superadmin-data";
import {
  superAdminApproveSignupRequestAction,
  superAdminRejectSignupRequestAction,
} from "../actions";

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

function buildWhatsappHref(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 7) return null;
  const normalized = digits.startsWith("0")
    ? `92${digits.slice(1)}`
    : digits;
  return `https://wa.me/${normalized}`;
}

export default function RequestsQueueClient({
  data,
}: {
  data: {
    requests: SignupRequestQueueRow[];
    pendingCount: number;
    featureFlags: PlatformFeatureFlags;
  };
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [search, setSearch] = useState("");
  const [approvingPilotId, setApprovingPilotId] = useState<string | null>(null);

  // Paid approval modal
  const [paidTarget, setPaidTarget] = useState<SignupRequestQueueRow | null>(
    null,
  );
  const [paidNote, setPaidNote] = useState("");
  const [paidSubmitting, setPaidSubmitting] = useState(false);

  // Reject modal (required reason)
  const [rejectTarget, setRejectTarget] =
    useState<SignupRequestQueueRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.requests.filter((r) => {
      if (tab === "pending" && r.orgStatus !== "pending") return false;
      if (!q) return true;
      return [
        r.orgName,
        r.orgSlug,
        r.contactName,
        r.email,
        r.whatsappNumber,
        r.planSummary,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [data.requests, tab, search]);

  async function handleApprovePilot(row: SignupRequestQueueRow) {
    if (!row.purchaseId) {
      showToast("Missing initial purchase record on this request.", "error");
      return;
    }

    setApprovingPilotId(row.orgId);
    try {
      const res = await superAdminApproveSignupRequestAction({
        orgId: row.orgId,
        purchaseId: row.purchaseId,
        mode: "pilot",
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        `Approved "${row.orgName}" as Pilot (100% discount · ${row.months} months active).`,
        "success",
      );
      router.refresh();
    } catch {
      showToast("Failed to approve pilot request.", "error");
    } finally {
      setApprovingPilotId(null);
    }
  }

  async function handleApprovePaidSubmit(e: FormEvent) {
    e.preventDefault();
    if (!paidTarget?.purchaseId) return;

    setPaidSubmitting(true);
    try {
      const res = await superAdminApproveSignupRequestAction({
        orgId: paidTarget.orgId,
        purchaseId: paidTarget.purchaseId,
        mode: "paid",
        paymentNote: paidNote.trim() || undefined,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        `Approved "${paidTarget.orgName}" as Paid (PKR ${paidTarget.finalPricePkr.toLocaleString()}).`,
        "success",
      );
      setPaidTarget(null);
      setPaidNote("");
      router.refresh();
    } catch {
      showToast("Failed to approve paid request.", "error");
    } finally {
      setPaidSubmitting(false);
    }
  }

  async function handleRejectSubmit(e: FormEvent) {
    e.preventDefault();
    if (!rejectTarget) return;

    const cleanReason = rejectReason.trim();
    if (cleanReason.length < 3) {
      setRejectError("Please provide a rejection reason (required).");
      return;
    }

    setRejectError(null);
    setRejectSubmitting(true);
    try {
      const res = await superAdminRejectSignupRequestAction({
        orgId: rejectTarget.orgId,
        purchaseId: rejectTarget.purchaseId ?? undefined,
        reason: cleanReason,
      });
      if (res.error) {
        setRejectError(res.error);
        return;
      }
      showToast(`Rejected "${rejectTarget.orgName}".`, "success");
      setRejectTarget(null);
      setRejectReason("");
      router.refresh();
    } catch {
      setRejectError("Failed to reject organization request.");
    } finally {
      setRejectSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Organization Signup Requests ({data.pendingCount} pending)
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Review pilot and paid signup requests. Every action is idempotent,
            gated by <code className="font-mono text-xs">public.super_admins</code>,
            and recorded in <code className="font-mono text-xs">audit_log</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
            Payment Proof:{" "}
            {data.featureFlags.requirePaymentProof ? "ON" : "OFF"}
          </span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
            Emails: {data.featureFlags.emailsEnabled ? "ON" : "OFF"}
          </span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
            Gateway: {data.featureFlags.paymentGatewayEnabled ? "ON" : "OFF"}
          </span>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("pending")}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition ${
              tab === "pending"
                ? "bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            Pending ({data.pendingCount})
          </button>
          <button
            type="button"
            onClick={() => setTab("all")}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition ${
              tab === "all"
                ? "bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            All Requests ({data.requests.length})
          </button>
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search org, contact, email, or WhatsApp..."
          className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none sm:w-80"
        />
      </div>

      {/* Requests table / cards */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 shadow-xs">
          {tab === "pending"
            ? "No pending signup requests right now."
            : "No signup requests match your search."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Organization</th>
                  <th className="px-4 py-3">Contact &amp; Email</th>
                  <th className="px-4 py-3">WhatsApp</th>
                  <th className="px-4 py-3">Plan Summary</th>
                  <th className="px-4 py-3">List Price</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row) => {
                  const waHref = buildWhatsappHref(row.whatsappNumber);
                  const isPending = row.orgStatus === "pending";
                  return (
                    <tr key={row.orgId} className="align-top hover:bg-slate-50/60">
                      <td className="px-4 py-3.5">
                        <Link
                          href={`/superadmin/organizations/${row.orgId}`}
                          className="font-bold text-slate-900 hover:text-indigo-600"
                        >
                          {row.orgName}
                        </Link>
                        <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                          /{row.orgSlug}
                        </div>
                        <div className="mt-1">
                          {row.orgStatus === "pending" && (
                            <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800 ring-1 ring-amber-200">
                              Pending
                            </span>
                          )}
                          {row.orgStatus === "active" && (
                            <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">
                              {row.isPilot ? "Approved · Pilot" : "Approved · Paid"}
                            </span>
                          )}
                          {row.orgStatus === "rejected" && (
                            <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-red-200">
                              Rejected
                            </span>
                          )}
                          {row.orgStatus === "suspended" && (
                            <span className="inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-800">
                              Suspended
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-slate-900">
                          {row.contactName}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-slate-600">
                          {row.email}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 font-mono">
                        {waHref ? (
                          <a
                            href={waHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800"
                          >
                            {row.whatsappNumber} ↗
                          </a>
                        ) : (
                          <span className="text-slate-600">
                            {row.whatsappNumber}
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3.5 text-slate-700">
                        <div className="font-semibold text-slate-900">
                          {row.planSummary}
                        </div>
                        {row.finalPricePkr !== row.listPricePkr && (
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            Package total: PKR{" "}
                            {row.finalPricePkr.toLocaleString()}
                          </div>
                        )}
                        {row.rejectionReason && (
                          <div className="mt-1 rounded-lg bg-red-50 px-2 py-1 text-[11px] text-red-700">
                            Reason: {row.rejectionReason}
                          </div>
                        )}
                        {row.paymentNote && row.orgStatus === "active" && (
                          <div className="mt-1 text-[11px] text-slate-500">
                            Note: {row.paymentNote}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3.5 font-mono font-bold text-slate-900">
                        PKR {row.listPricePkr.toLocaleString()}
                      </td>

                      <td className="px-4 py-3.5 text-slate-500">
                        {formatDateTime(row.createdAt)}
                      </td>

                      <td className="px-4 py-3.5 text-right">
                        {isPending ? (
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              loading={approvingPilotId === row.orgId}
                              disabled={
                                !row.purchaseId || approvingPilotId !== null
                              }
                              onClick={() => handleApprovePilot(row)}
                            >
                              Approve as Pilot
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={
                                !row.purchaseId || approvingPilotId !== null
                              }
                              onClick={() => {
                                setPaidTarget(row);
                                setPaidNote("");
                              }}
                            >
                              Approve as Paid
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={approvingPilotId !== null}
                              onClick={() => {
                                setRejectTarget(row);
                                setRejectReason("");
                                setRejectError(null);
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            {row.reviewedBy
                              ? `By ${row.reviewedBy}`
                              : "Reviewed"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: Approve as Paid */}
      <Modal
        open={Boolean(paidTarget)}
        onClose={() => !paidSubmitting && setPaidTarget(null)}
        title={
          paidTarget
            ? `Approve "${paidTarget.orgName}" as Paid`
            : "Approve as Paid"
        }
        description="Activates both the organization and package purchase immediately (is_pilot = false)."
      >
        {paidTarget && (
          <form onSubmit={handleApprovePaidSubmit} className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700">
              <p className="font-bold text-slate-900">
                {paidTarget.planSummary}
              </p>
              <p className="mt-1">
                List Price: PKR {paidTarget.listPricePkr.toLocaleString()} ·
                Final Paid Amount:{" "}
                <strong className="font-mono text-indigo-700">
                  PKR {paidTarget.finalPricePkr.toLocaleString()}
                </strong>
              </p>
            </div>

            <Input
              label="Private Payment Note (optional)"
              placeholder="e.g. Received PKR via Meezan IBFT ref #88412"
              value={paidNote}
              onChange={(e) => setPaidNote(e.target.value)}
              disabled={paidSubmitting}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPaidTarget(null)}
                disabled={paidSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={paidSubmitting}>
                Confirm Paid Approval
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Modal: Reject Request (required reason) */}
      <Modal
        open={Boolean(rejectTarget)}
        onClose={() => !rejectSubmitting && setRejectTarget(null)}
        title={
          rejectTarget
            ? `Reject "${rejectTarget.orgName}"`
            : "Reject Organization Request"
        }
        description="This marks the organization as 'rejected' and displays your reason on their /pending screen."
      >
        {rejectTarget && (
          <form onSubmit={handleRejectSubmit} className="space-y-4">
            {rejectError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700">
                {rejectError}
              </div>
            )}

            <div>
              <label
                htmlFor="reject-reason"
                className="mb-1.5 block text-xs font-semibold text-slate-700"
              >
                Rejection Reason (required) *
              </label>
              <textarea
                id="reject-reason"
                rows={3}
                required
                minLength={3}
                maxLength={1000}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Explain clearly why the request could not be approved..."
                disabled={rejectSubmitting}
                className="block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRejectTarget(null)}
                disabled={rejectSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="sm"
                loading={rejectSubmitting}
              >
                Reject Request
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
