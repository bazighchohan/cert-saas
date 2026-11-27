"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Modal, useToast } from "@/components/ui";
import type { SuperAdminPaymentsQueueData } from "@/lib/superadmin-data";
import {
  superAdminReviewPurchaseAction,
  superAdminReviewTopupAction,
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

export default function PaymentsQueueClient({
  data,
}: {
  data: SuperAdminPaymentsQueueData;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<
    "pending" | "approved" | "rejected" | "all"
  >("pending");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const filteredPurchases = useMemo(
    () =>
      data.purchases.filter((p) => {
        if (statusFilter === "all") return true;
        if (statusFilter === "approved") {
          return p.status === "active" || p.status === "expired";
        }
        return p.status === statusFilter;
      }),
    [data.purchases, statusFilter],
  );

  const filteredTopups = useMemo(
    () =>
      data.topups.filter((t) => {
        if (statusFilter === "all") return true;
        return t.status === statusFilter;
      }),
    [data.topups, statusFilter],
  );

  const pendingTotal =
    data.purchases.filter((p) => p.status === "pending").length +
    data.topups.filter((t) => t.status === "pending").length;

  async function handleReviewPurchase(
    purchaseId: string,
    decision: "approved" | "rejected",
  ) {
    setReviewingId(purchaseId);
    try {
      const res = await superAdminReviewPurchaseAction({
        purchaseId,
        decision,
        note: notes[purchaseId] ?? "",
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        decision === "approved"
          ? "Package purchase approved — slots activated!"
          : "Package purchase rejected.",
        "success",
      );
      setPreviewId(null);
      router.refresh();
    } catch {
      showToast("Failed to review purchase.", "error");
    } finally {
      setReviewingId(null);
    }
  }

  async function handleReviewTopup(
    topupId: string,
    decision: "approved" | "rejected",
  ) {
    setReviewingId(topupId);
    try {
      const res = await superAdminReviewTopupAction({
        topupId,
        decision,
        note: notes[topupId] ?? "",
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        decision === "approved"
          ? "Certificate top-up approved — event max_certificates increased!"
          : "Certificate top-up rejected.",
        "success",
      );
      setPreviewId(null);
      router.refresh();
    } catch {
      showToast("Failed to review top-up.", "error");
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Package Purchases &amp; Certificate Top-Ups ({pendingTotal} pending)
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Verify Bank Transfer, JazzCash, and Easypaisa receipt screenshots and
          approve or reject package purchases and event certificate top-ups.
        </p>
      </div>

      {/* Status Filter Tabs */}
      <div className="inline-flex rounded-xl bg-slate-200/80 p-1 text-xs font-semibold">
        {(
          [
            { id: "pending", label: `Pending (${pendingTotal})` },
            { id: "approved", label: "Approved" },
            { id: "rejected", label: "Rejected" },
            { id: "all", label: "All" },
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

      {/* 1. Package Purchases */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Package Purchases ({filteredPurchases.length})
        </h2>

        {filteredPurchases.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
            No matching package purchases.
          </div>
        ) : (
          filteredPurchases.map((p) => (
            <div
              key={p.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/superadmin/organizations/${p.orgId}`}
                      className="text-base font-bold text-slate-900 hover:text-indigo-600"
                    >
                      {p.orgName || p.orgId}
                    </Link>
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-bold uppercase text-indigo-700">
                      {p.kind} ({p.eventsTotal} events × {p.certsPerEvent} certs · {p.months}m)
                    </span>
                    <span className="font-mono text-sm font-bold text-emerald-700">
                      PKR {p.finalPricePkr.toLocaleString()}
                    </span>
                  </div>

                  <p className="text-slate-600">
                    Method:{" "}
                    <strong className="uppercase">
                      {p.paymentMethod || "—"}
                    </strong>{" "}
                    · Ref:{" "}
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                      {p.transactionReference || "—"}
                    </code>{" "}
                    · Submitted {formatDateTime(p.createdAt)}
                  </p>
                </div>

                {p.hasScreenshot && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPreviewId(p.id)}
                  >
                    🖼️ Preview Proof
                  </Button>
                )}
              </div>

              {p.status === "pending" && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <input
                    type="text"
                    placeholder="Optional reviewer note..."
                    value={notes[p.id] ?? ""}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                    className="w-64 rounded-xl border border-slate-300 px-3 py-1.5 text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      loading={reviewingId === p.id}
                      onClick={() => void handleReviewPurchase(p.id, "approved")}
                    >
                      ✓ Approve Package ({p.months}m)
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={reviewingId === p.id}
                      onClick={() => void handleReviewPurchase(p.id, "rejected")}
                    >
                      ✕ Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </section>

      {/* 2. Certificate Top-Ups */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Certificate Top-Ups ({filteredTopups.length})
        </h2>

        {filteredTopups.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
            No matching certificate top-up requests.
          </div>
        ) : (
          filteredTopups.map((t) => (
            <div
              key={t.id}
              className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/superadmin/organizations/${t.orgId}`}
                      className="text-base font-bold text-slate-900 hover:text-indigo-600"
                    >
                      {t.orgName || t.orgId}
                    </Link>
                    <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 font-bold text-indigo-800">
                      +{t.certsAdded} certificates ({t.eventTitle})
                    </span>
                    <span className="font-mono text-sm font-bold text-emerald-700">
                      PKR {t.amountPkr.toLocaleString()}
                    </span>
                  </div>

                  <p className="text-slate-600">
                    Method:{" "}
                    <strong className="uppercase">
                      {t.paymentMethod || "—"}
                    </strong>{" "}
                    · Ref:{" "}
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                      {t.transactionReference || "—"}
                    </code>{" "}
                    · Submitted {formatDateTime(t.createdAt)}
                  </p>
                </div>

                {t.hasScreenshot && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPreviewId(t.id)}
                  >
                    🖼️ Preview Proof
                  </Button>
                )}
              </div>

              {t.status === "pending" && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <input
                    type="text"
                    placeholder="Optional reviewer note..."
                    value={notes[t.id] ?? ""}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [t.id]: e.target.value }))
                    }
                    className="w-64 rounded-xl border border-slate-300 px-3 py-1.5 text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      loading={reviewingId === t.id}
                      onClick={() => void handleReviewTopup(t.id, "approved")}
                    >
                      ✓ Approve (+{t.certsAdded} certs)
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={reviewingId === t.id}
                      onClick={() => void handleReviewTopup(t.id, "rejected")}
                    >
                      ✕ Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </section>

      {/* Proof Modal */}
      <Modal
        open={Boolean(previewId)}
        onClose={() => setPreviewId(null)}
        title="Payment Proof Receipt"
        maxWidthClass="max-w-2xl"
      >
        {previewId && (
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/superadmin/payment-requests/${previewId}/screenshot`}
              alt="Payment receipt"
              className="max-h-[65vh] w-auto rounded-xl border border-slate-200 object-contain"
            />
            <a
              href={`/api/superadmin/payment-requests/${previewId}/screenshot`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-semibold text-indigo-600 hover:underline"
            >
              Open Raw Receipt ↗
            </a>
          </div>
        )}
      </Modal>
    </div>
  );
}
