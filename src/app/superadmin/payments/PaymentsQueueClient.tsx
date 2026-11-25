"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Modal, useToast } from "@/components/ui";
import type { SuperAdminPaymentRow } from "@/lib/superadmin-data";
import { superAdminReviewPaymentAction } from "../actions";

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

export default function PaymentsQueueClient({
  requests,
}: {
  requests: SuperAdminPaymentRow[];
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<
    "pending" | "approved" | "rejected" | "all"
  >("pending");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [daysById, setDaysById] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [previewReq, setPreviewReq] = useState<SuperAdminPaymentRow | null>(
    null,
  );

  const counts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const r of requests) {
      if (r.status === "pending") pending++;
      else if (r.status === "approved") approved++;
      else rejected++;
    }
    return { pending, approved, rejected, all: requests.length };
  }, [requests]);

  const filtered = useMemo(
    () =>
      statusFilter === "all"
        ? requests
        : requests.filter((r) => r.status === statusFilter),
    [requests, statusFilter],
  );

  async function handleReview(
    req: SuperAdminPaymentRow,
    decision: "approved" | "rejected",
  ) {
    setReviewingId(req.id);
    try {
      const billingDays = Math.max(
        1,
        Number(daysById[req.id] ?? req.billingDays ?? 30) || 30,
      );
      const res = await superAdminReviewPaymentAction({
        requestId: req.id,
        decision,
        reviewerNote: notes[req.id] ?? "",
        billingDays,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        decision === "approved"
          ? `Approved ${req.orgName} → ${req.planName} (+${billingDays} days).`
          : `Rejected payment request from ${req.orgName}.`,
        "success",
      );
      setPreviewReq(null);
      router.refresh();
    } catch {
      showToast("Failed to process payment review.", "error");
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Payment Requests Queue
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Verify manual Bank Transfer, JazzCash, and Easypaisa proof screenshots
          and approve or reject plan upgrades. Every decision writes to{" "}
          <code className="font-mono">audit_log</code>.
        </p>
      </div>

      {/* Status Filter Tabs */}
      <div className="inline-flex rounded-xl bg-slate-200/80 p-1 text-xs font-semibold">
        {(
          [
            { id: "pending", label: `Pending (${counts.pending})` },
            { id: "approved", label: `Approved (${counts.approved})` },
            { id: "rejected", label: `Rejected (${counts.rejected})` },
            { id: "all", label: `All (${counts.all})` },
          ] as const
        ).map((tab) => {
          const active = statusFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`rounded-lg px-3.5 py-1.5 transition ${
                active
                  ? "bg-white text-indigo-700 shadow-2xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Queue List */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-xs text-slate-500 shadow-xs">
          No {statusFilter === "all" ? "" : statusFilter} payment requests found.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((req) => (
            <div
              key={req.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/superadmin/organizations/${req.orgId}`}
                      className="text-base font-bold text-slate-900 hover:text-indigo-600"
                    >
                      {req.orgName}
                    </Link>
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-semibold uppercase text-indigo-700 ring-1 ring-indigo-200">
                      → {req.planName}
                    </span>
                    <span className="font-mono text-sm font-bold text-emerald-700">
                      PKR {req.amountPkr.toLocaleString()}
                    </span>
                  </div>

                  <p className="text-slate-600">
                    Method:{" "}
                    <strong className="uppercase">{req.paymentMethod}</strong> ·
                    Transaction Ref:{" "}
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-semibold text-slate-900">
                      {req.transactionReference}
                    </code>{" "}
                    · Submitted {formatDateTime(req.createdAt)}
                  </p>

                  {req.reviewedAt && (
                    <p className="text-slate-500">
                      Reviewed {formatDateTime(req.reviewedAt)}
                      {req.reviewedBy ? ` by ${req.reviewedBy}` : ""}
                      {req.reviewerNote ? ` — Note: "${req.reviewerNote}"` : ""}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {req.hasScreenshot && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPreviewReq(req)}
                      >
                        🖼️ Preview Proof
                      </Button>
                      <a
                        href={`/api/superadmin/payment-requests/${req.id}/screenshot`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        Open Raw ↗
                      </a>
                    </>
                  )}
                </div>
              </div>

              {req.status === "pending" && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs font-semibold text-slate-600">
                      Days:
                      <input
                        type="number"
                        min={1}
                        max={3660}
                        value={daysById[req.id] ?? String(req.billingDays)}
                        onChange={(e) =>
                          setDaysById((prev) => ({
                            ...prev,
                            [req.id]: e.target.value,
                          }))
                        }
                        className="ml-1.5 w-20 rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-900"
                      />
                    </label>
                    <input
                      type="text"
                      placeholder="Reviewer note (optional, visible to org)..."
                      value={notes[req.id] ?? ""}
                      onChange={(e) =>
                        setNotes((prev) => ({
                          ...prev,
                          [req.id]: e.target.value,
                        }))
                      }
                      className="w-64 rounded-xl border border-slate-300 px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      loading={reviewingId === req.id}
                      onClick={() => void handleReview(req, "approved")}
                    >
                      ✓ Approve Upgrade
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={reviewingId === req.id}
                      onClick={() => void handleReview(req, "rejected")}
                    >
                      ✕ Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Proof Screenshot Preview Modal */}
      <Modal
        open={Boolean(previewReq)}
        onClose={() => setPreviewReq(null)}
        title={`Payment Proof — ${previewReq?.orgName ?? ""}`}
        description={
          previewReq
            ? `${previewReq.planName} · PKR ${previewReq.amountPkr.toLocaleString()} · ${previewReq.paymentMethod.toUpperCase()} #${previewReq.transactionReference}`
            : undefined
        }
        maxWidthClass="max-w-2xl"
        footer={
          previewReq?.status === "pending" ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPreviewReq(null)}
              >
                Close
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={reviewingId === previewReq.id}
                onClick={() => void handleReview(previewReq, "rejected")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                loading={reviewingId === previewReq.id}
                onClick={() => void handleReview(previewReq, "approved")}
              >
                Approve Upgrade
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPreviewReq(null)}
            >
              Close
            </Button>
          )
        }
      >
        {previewReq && (
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/superadmin/payment-requests/${previewReq.id}/screenshot`}
              alt="Uploaded payment receipt"
              className="max-h-[65vh] w-auto rounded-xl border border-slate-200 object-contain"
            />
            <p className="text-[11px] text-slate-500">
              If the uploaded receipt is a PDF document, click{" "}
              <a
                href={`/api/superadmin/payment-requests/${previewReq.id}/screenshot`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-indigo-600 hover:underline"
              >
                Open Raw ↗
              </a>{" "}
              to view it in your browser&apos;s PDF viewer.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
