"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AttendeeDownloadHistoryItem } from "@/app/api/dashboard/events/[eventId]/downloads/history/[attendeeId]/route";
import { Button, EmptyState, Modal, useToast } from "@/components/ui";
import type { CertificateTypeRow } from "@/lib/dashboard-data";
import type {
  ComputedDownloadRow,
  DailyDownloadPoint,
  DownloadStatusFilter,
} from "@/lib/downloads-analytics";
import {
  resetAttendeeDownloadsAction,
  saveAttendeeIssueNoteAction,
} from "./attendee-actions";

const PAGE_SIZE = 50;

interface SummaryMetrics {
  totalAttendees: number;
  downloadedCount: number;
  notDownloadedCount: number;
  completionPct: number;
  totalLogDownloads: number;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DownloadsTabClient({
  eventId,
  identifierLabel,
  certificateTypes,
}: {
  eventId: string;
  identifierLabel: string;
  certificateTypes: CertificateTypeRow[];
}) {
  const router = useRouter();
  const { showToast } = useToast();

  // Filter & pagination state
  const [statusFilter, setStatusFilter] = useState<DownloadStatusFilter>("all");
  const [certTypeIdFilter, setCertTypeIdFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  // Loaded analytics state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryMetrics>({
    totalAttendees: 0,
    downloadedCount: 0,
    notDownloadedCount: 0,
    completionPct: 0,
    totalLogDownloads: 0,
  });
  const [pendingEmails, setPendingEmails] = useState<string[]>([]);
  const [dailySeries, setDailySeries] = useState<DailyDownloadPoint[]>([]);
  const [rows, setRows] = useState<ComputedDownloadRow[]>([]);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Per-attendee Download History Modal
  const [historyAttendee, setHistoryAttendee] =
    useState<ComputedDownloadRow | null>(null);
  const [historyItems, setHistoryItems] = useState<
    AttendeeDownloadHistoryItem[]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Issues / Name-Correction Note Modal
  const [issueAttendee, setIssueAttendee] =
    useState<ComputedDownloadRow | null>(null);
  const [issueDraft, setIssueDraft] = useState("");
  const [savingIssue, setSavingIssue] = useState(false);

  // Resetting download counter state
  const [resettingId, setResettingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      if (certTypeIdFilter) params.set("certTypeId", certTypeIdFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);

      const res = await fetch(
        `/api/dashboard/events/${eventId}/downloads?${params.toString()}`,
        { cache: "no-store" },
      );

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        summary?: SummaryMetrics;
        pendingEmails?: string[];
        dailySeries?: DailyDownloadPoint[];
        rows?: ComputedDownloadRow[];
        totalFiltered?: number;
        totalPages?: number;
      };

      if (!res.ok || data.error) {
        setError(data.error || "Failed to load download analytics.");
        return;
      }

      if (data.summary) setSummary(data.summary);
      setPendingEmails(data.pendingEmails ?? []);
      setDailySeries(data.dailySeries ?? []);
      setRows(data.rows ?? []);
      setTotalFiltered(data.totalFiltered ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } catch {
      setError("Network error while loading download tracking data.");
    } finally {
      setLoading(false);
    }
  }, [eventId, statusFilter, certTypeIdFilter, debouncedSearch, page]);

  useEffect(() => {
    void fetchAnalytics();
  }, [fetchAnalytics]);

  function buildExportHref(
    exportStatus: "downloaded" | "not_downloaded",
    format: "csv" | "xlsx",
  ): string {
    const params = new URLSearchParams();
    params.set("status", exportStatus);
    params.set("format", format);
    if (certTypeIdFilter) params.set("certTypeId", certTypeIdFilter);
    return `/api/dashboard/events/${eventId}/downloads/export?${params.toString()}`;
  }

  async function handleCopyPendingEmails() {
    if (pendingEmails.length === 0) return;
    try {
      await navigator.clipboard.writeText(pendingEmails.join(", "));
      showToast(
        `Copied ${pendingEmails.length} email address${
          pendingEmails.length === 1 ? "" : "es"
        } of attendees who haven't downloaded yet.`,
        "success",
      );
    } catch {
      showToast("Clipboard access blocked by browser.", "error");
    }
  }

  async function openHistoryModal(attendee: ComputedDownloadRow) {
    setHistoryAttendee(attendee);
    setHistoryItems([]);
    setHistoryLoading(true);

    try {
      const res = await fetch(
        `/api/dashboard/events/${eventId}/downloads/history/${attendee.id}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        history?: AttendeeDownloadHistoryItem[];
      };
      setHistoryItems(data.history ?? []);
    } catch {
      showToast("Failed to load attendee download history.", "error");
    } finally {
      setHistoryLoading(false);
    }
  }

  function openIssueModal(attendee: ComputedDownloadRow) {
    setIssueAttendee(attendee);
    setIssueDraft(attendee.issueNote ?? "");
  }

  async function handleSaveIssueNote(e: FormEvent) {
    e.preventDefault();
    if (!issueAttendee) return;

    setSavingIssue(true);
    try {
      const res = await saveAttendeeIssueNoteAction({
        eventId,
        attendeeId: issueAttendee.id,
        issueNote: issueDraft,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        issueDraft.trim()
          ? `Saved issue note for ${issueAttendee.fullName}.`
          : `Cleared issue note for ${issueAttendee.fullName}.`,
        "success",
      );
      setIssueAttendee(null);
      await fetchAnalytics();
      router.refresh();
    } catch {
      showToast("Failed to save issue note.", "error");
    } finally {
      setSavingIssue(false);
    }
  }

  async function handleResetAttendee(attendee: ComputedDownloadRow) {
    setResettingId(attendee.id);
    try {
      const res = await resetAttendeeDownloadsAction({
        eventId,
        attendeeId: attendee.id,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(`Reset download count for ${attendee.fullName}.`, "success");
      await fetchAnalytics();
      router.refresh();
    } catch {
      showToast("Failed to reset download count.", "error");
    } finally {
      setResettingId(null);
    }
  }

  const rangeStart = totalFiltered === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(totalFiltered, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* 1. Summary KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Total Attendees
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {summary.totalAttendees.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {certTypeIdFilter ? "Assigned selected type" : "Registered in event"}
          </p>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Downloaded
          </p>
          <p className="mt-2 text-2xl font-bold text-emerald-950">
            {summary.downloadedCount.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            {summary.totalLogDownloads.toLocaleString()} total PDF download
            {summary.totalLogDownloads === 1 ? "" : "s"}
          </p>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Not Downloaded
          </p>
          <p className="mt-2 text-2xl font-bold text-amber-950">
            {summary.notDownloadedCount.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {pendingEmails.length > 0
              ? `${pendingEmails.length} with email address`
              : "Awaiting download"}
          </p>
        </div>

        <div className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-xs">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
              Completion %
            </p>
            <span className="text-2xl font-bold text-indigo-950">
              {summary.completionPct}%
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all duration-300"
              style={{ width: `${Math.min(100, summary.completionPct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {summary.downloadedCount} of {summary.totalAttendees} claimed
          </p>
        </div>
      </div>

      {/* 2. Downloads Per Day Chart (Recharts) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900 sm:text-base">
              Downloads per Day
            </h2>
            <p className="text-xs text-slate-500">
              Daily certificate download activity from <code className="font-mono">download_log</code>
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {summary.totalLogDownloads.toLocaleString()} total download event
            {summary.totalLogDownloads === 1 ? "" : "s"}
          </span>
        </div>

        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={dailySeries}
              margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#64748B" }}
                tickLine={false}
                axisLine={{ stroke: "#CBD5E1" }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "#64748B" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: "12px",
                  border: "1px solid #E2E8F0",
                  fontSize: "12px",
                }}
              />
              <Bar
                dataKey="downloads"
                name="Downloads"
                fill="#4F46E5"
                radius={[6, 6, 0, 0]}
                maxBarSize={36}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* 3. Exports & Copy Pending Emails Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-bold text-slate-700">
            Export Downloaded ({summary.downloadedCount}):
          </span>
          <a
            href={buildExportHref("downloaded", "csv")}
            download
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ⬇ CSV
          </a>
          <a
            href={buildExportHref("downloaded", "xlsx")}
            download
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ⬇ Excel (.xlsx)
          </a>

          <span className="mx-1 text-slate-300">|</span>

          <span className="mr-1 text-xs font-bold text-slate-700">
            Export Not Downloaded ({summary.notDownloadedCount}):
          </span>
          <a
            href={buildExportHref("not_downloaded", "csv")}
            download
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ⬇ CSV
          </a>
          <a
            href={buildExportHref("not_downloaded", "xlsx")}
            download
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            ⬇ Excel (.xlsx)
          </a>
        </div>

        {pendingEmails.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCopyPendingEmails()}
          >
            📋 Copy emails of people who haven&apos;t downloaded ({pendingEmails.length})
          </Button>
        )}
      </div>

      {/* 4. Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        {/* Status segmented filter */}
        <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
          {(
            [
              {
                id: "all",
                label: `All (${summary.totalAttendees})`,
              },
              {
                id: "downloaded",
                label: `Downloaded (${summary.downloadedCount})`,
              },
              {
                id: "not_downloaded",
                label: `Not Downloaded (${summary.notDownloadedCount})`,
              },
            ] as const
          ).map((tab) => {
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setStatusFilter(tab.id);
                  setPage(1);
                }}
                className={`rounded-lg px-3 py-1.5 transition ${
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

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Certificate type filter */}
          <select
            value={certTypeIdFilter}
            onChange={(e) => {
              setCertTypeIdFilter(e.target.value);
              setPage(1);
            }}
            aria-label="Filter by certificate type"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">All certificate types</option>
            {certificateTypes.map((ct) => (
              <option key={ct.id} value={ct.id}>
                {ct.label}
              </option>
            ))}
          </select>

          {/* Search */}
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={`Search ${identifierLabel.toLowerCase()}, name, email, or issue...`}
            className="w-60 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      {/* 5. Filterable Table */}
      {!loading && summary.totalAttendees === 0 ? (
        <EmptyState
          icon="📥"
          title="No attendees in this view yet"
          description="Add or import attendees in the Attendees tab to track certificate downloads and export reports."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{identifierLabel}</th>
                  <th className="px-4 py-3">Attendee</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Certificates</th>
                  <th className="px-4 py-3">Last Downloaded</th>
                  <th className="px-4 py-3">Issues / Correction Note</th>
                  <th className="px-4 py-3 text-right">History &amp; Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {loading ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-10 text-center text-xs font-medium text-slate-500"
                    >
                      Loading download records...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-10 text-center text-xs text-slate-500"
                    >
                      No attendees match the selected download filter.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className="transition hover:bg-slate-50/70"
                    >
                      <td className="px-4 py-3 align-top font-mono text-xs font-semibold text-slate-900">
                        {row.identifier}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-slate-900">
                          {row.fullName}
                        </div>
                        {row.email && (
                          <div className="text-xs text-slate-500">
                            {row.email}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 align-top">
                        {row.hasDownloaded ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                            ✓ Downloaded ({row.relevantDownloads})
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                            Not downloaded
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap gap-1.5">
                          {row.certificates.map((c) => (
                            <span
                              key={c.id}
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                c.downloadCount > 0
                                  ? "bg-indigo-50 text-indigo-800 ring-1 ring-indigo-200"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              <span>{c.certificateTypeLabel}</span>
                              <span className="font-bold">
                                ({c.downloadCount})
                              </span>
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top text-xs text-slate-600 whitespace-nowrap">
                        {formatDateTime(row.lastDownloadedAt)}
                      </td>

                      <td className="max-w-[230px] px-4 py-3 align-top text-xs">
                        {row.issueNote ? (
                          <div className="space-y-1">
                            <p
                              className="line-clamp-2 rounded-lg bg-amber-50 px-2.5 py-1 text-amber-950 ring-1 ring-amber-200"
                              title={row.issueNote}
                            >
                              {row.issueNote}
                            </p>
                            <button
                              type="button"
                              onClick={() => openIssueModal(row)}
                              className="text-[11px] font-semibold text-indigo-600 hover:underline"
                            >
                              Edit issue note
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openIssueModal(row)}
                            className="text-xs font-medium text-slate-400 hover:text-indigo-600"
                          >
                            + Add issue note
                          </button>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right align-top whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void openHistoryModal(row)}
                          >
                            History
                          </Button>
                          {row.relevantDownloads > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={resettingId === row.id}
                              onClick={() => void handleResetAttendee(row)}
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-600 sm:px-6">
            <span>
              Showing <strong className="text-slate-900">{rangeStart}</strong>–
              <strong className="text-slate-900">{rangeEnd}</strong> of{" "}
              <strong className="text-slate-900">{totalFiltered}</strong> matching
              attendee{totalFiltered === 1 ? "" : "s"}
            </span>

            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Previous
              </Button>
              <span className="px-2.5 font-semibold text-slate-800">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Per-Attendee Download History Modal */}
      <Modal
        open={Boolean(historyAttendee)}
        onClose={() => setHistoryAttendee(null)}
        title={`Download History — ${historyAttendee?.fullName ?? ""}`}
        description={
          historyAttendee
            ? `${identifierLabel}: ${historyAttendee.identifier}`
            : undefined
        }
        maxWidthClass="max-w-lg"
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setHistoryAttendee(null)}
          >
            Close
          </Button>
        }
      >
        {historyLoading ? (
          <p className="py-6 text-center text-xs text-slate-500">
            Loading download log...
          </p>
        ) : historyItems.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">
            No download events recorded in <code className="font-mono">download_log</code> for this attendee yet.
          </p>
        ) : (
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
            {historyItems.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 py-2.5 text-xs"
              >
                <div>
                  <p className="font-semibold text-slate-900">
                    {item.certificateTypeLabel}
                  </p>
                  <p className="font-mono text-[11px] text-slate-500">
                    Code: {item.verifyCode || "—"}
                    {item.ipFingerprint
                      ? ` · IP hash: ${item.ipFingerprint}…`
                      : ""}
                  </p>
                </div>
                <span className="shrink-0 font-medium text-slate-700">
                  {formatDateTime(item.downloadedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* Issues / Name-Correction Note Modal */}
      <Modal
        open={Boolean(issueAttendee)}
        onClose={() => !savingIssue && setIssueAttendee(null)}
        title={`Issues / Name Correction Note — ${issueAttendee?.fullName ?? ""}`}
        description="Record why an attendee's name was corrected or document any certificate issue."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleSaveIssueNote} className="space-y-4">
          <div>
            <label
              htmlFor="attendee-issue-note"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Issue / correction reason
            </label>
            <textarea
              id="attendee-issue-note"
              rows={4}
              maxLength={1000}
              value={issueDraft}
              onChange={(e) => setIssueDraft(e.target.value)}
              disabled={savingIssue}
              placeholder="e.g. Corrected name spelling from 'Muhamad' to 'Muhammad' per student email request and reset download counter."
              className="block w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={savingIssue}
              onClick={() => setIssueAttendee(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={savingIssue}
            >
              Save Issue Note
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
