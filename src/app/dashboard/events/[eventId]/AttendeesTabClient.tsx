"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  useToast,
} from "@/components/ui";
import type {
  AttendeeListItem,
  AttendeeSortField,
} from "@/app/api/dashboard/events/[eventId]/attendees/route";
import { validateAttendeeFields } from "@/lib/attendee-validation";
import type { CertificateTypeRow } from "@/lib/dashboard-data";
import ImportWizardModal from "./ImportWizardModal";
import {
  addAttendeeAction,
  bulkDeleteAttendeesAction,
  bulkSetCertificateTypeAction,
  deleteAttendeeAction,
  resetAttendeeDownloadsAction,
  setAttendeeCertificateTypeAction,
  updateAttendeeAction,
} from "./attendee-actions";

const PAGE_SIZE = 50;

interface QuotaState {
  planName: string;
  eventCertsUsed: number;
  maxCertificatesPerEvent: number | null;
  orgCertsUsed: number;
  maxCertificatesTotal: number | null;
}

export default function AttendeesTabClient({
  eventId,
  identifierLabel,
  uppercaseIdentifiers,
  certificateTypes,
  initialPlanName,
}: {
  eventId: string;
  identifierLabel: string;
  uppercaseIdentifiers: boolean;
  certificateTypes: CertificateTypeRow[];
  initialPlanName: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  // Table state (server-side 50/page)
  const [attendees, setAttendees] = useState<AttendeeListItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"" | "csv" | "manual">("");
  const [sortBy, setSortBy] = useState<AttendeeSortField>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [quota, setQuota] = useState<QuotaState>({
    planName: initialPlanName,
    eventCertsUsed: 0,
    maxCertificatesPerEvent: null,
    orgCertsUsed: 0,
    maxCertificatesTotal: null,
  });

  // Add Attendee Form state
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [newIdentifier, setNewIdentifier] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newTypeIds, setNewTypeIds] = useState<string[]>(() =>
    certificateTypes[0] ? [certificateTypes[0].id] : [],
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Selection & Bulk Actions state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTypeId, setBulkTypeId] = useState<string>(
    certificateTypes[0]?.id ?? "",
  );
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Single Delete Dialog state
  const [deletingAttendee, setDeletingAttendee] =
    useState<AttendeeListItem | null>(null);
  const [deletingSingle, setDeletingSingle] = useState(false);

  // Inline Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editIdentifier, setEditIdentifier] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editNote, setEditNote] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Per-checkbox in-flight key `${attendeeId}:${certTypeId}`
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [resettingAttendeeId, setResettingAttendeeId] = useState<string | null>(
    null,
  );

  // Keep bulkTypeId valid when certificateTypes change
  useEffect(() => {
    if (
      certificateTypes.length > 0 &&
      !certificateTypes.some((t) => t.id === bulkTypeId)
    ) {
      setBulkTypeId(certificateTypes[0].id);
    }
  }, [certificateTypes, bulkTypeId]);

  // Debounce search input -> reset to page 1
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchAttendees = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (sourceFilter) params.set("source", sourceFilter);

      const res = await fetch(
        `/api/dashboard/events/${eventId}/attendees?${params.toString()}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        attendees?: AttendeeListItem[];
        totalCount?: number;
        totalPages?: number;
        quota?: QuotaState;
      };

      if (!res.ok || data.error) {
        setLoadError(data.error || "Failed to load attendees.");
        return;
      }

      setAttendees(data.attendees ?? []);
      setTotalCount(data.totalCount ?? 0);
      setTotalPages(data.totalPages ?? 1);
      if (data.quota) {
        setQuota(data.quota);
      }
    } catch {
      setLoadError("Network error while loading attendees.");
    } finally {
      setLoading(false);
    }
  }, [eventId, page, sortBy, sortDir, debouncedSearch, sourceFilter]);

  useEffect(() => {
    void fetchAttendees();
  }, [fetchAttendees]);

  // Selection helpers
  const allCurrentPageSelected = useMemo(
    () =>
      attendees.length > 0 && attendees.every((a) => selectedIds.has(a.id)),
    [attendees, selectedIds],
  );

  function toggleSelectAllPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allCurrentPageSelected) {
        for (const a of attendees) next.delete(a.id);
      } else {
        for (const a of attendees) next.add(a.id);
      }
      return next;
    });
  }

  function toggleSelectRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSort(field: AttendeeSortField) {
    if (sortBy === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "downloads" ? "desc" : "asc");
    }
    setPage(1);
  }

  function sortIndicator(field: AttendeeSortField) {
    if (sortBy !== field) return <span className="text-slate-300">↕</span>;
    return (
      <span className="text-indigo-600">{sortDir === "asc" ? "↑" : "↓"}</span>
    );
  }

  // Add attendee submit
  async function handleAddAttendee(e: FormEvent) {
    e.preventDefault();
    setAddError(null);

    const check = validateAttendeeFields({
      identifier: newIdentifier,
      fullName: newFullName,
      email: newEmail,
      note: newNote,
      uppercaseIdentifiers,
      identifierLabel,
    });

    if (check.error) {
      setAddError(check.error);
      return;
    }

    setAdding(true);
    try {
      const res = await addAttendeeAction({
        eventId,
        identifier: newIdentifier,
        fullName: newFullName,
        email: newEmail,
        note: newNote,
        certificateTypeIds: newTypeIds,
      });

      if (res.error) {
        setAddError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast(`Added attendee "${newFullName.trim()}".`, "success");
      setNewIdentifier("");
      setNewFullName("");
      setNewEmail("");
      setNewNote("");
      await fetchAttendees();
      router.refresh();
    } catch {
      const msg = "Failed to add attendee.";
      setAddError(msg);
      showToast(msg, "error");
    } finally {
      setAdding(false);
    }
  }

  // Inline edit start / cancel / save
  function beginInlineEdit(row: AttendeeListItem) {
    setEditingId(row.id);
    setEditIdentifier(row.identifier);
    setEditFullName(row.fullName);
    setEditEmail(row.email ?? "");
    setEditNote(row.note ?? "");
    setEditError(null);
  }

  function cancelInlineEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveInlineEdit(attendeeId: string) {
    setEditError(null);

    const check = validateAttendeeFields({
      identifier: editIdentifier,
      fullName: editFullName,
      email: editEmail,
      note: editNote,
      uppercaseIdentifiers,
      identifierLabel,
    });

    if (check.error) {
      setEditError(check.error);
      return;
    }

    setSavingEdit(true);
    try {
      const res = await updateAttendeeAction({
        eventId,
        attendeeId,
        identifier: editIdentifier,
        fullName: editFullName,
        email: editEmail,
        note: editNote,
      });

      if (res.error) {
        setEditError(res.error);
        showToast(res.error, "error");
        return;
      }

      showToast("Attendee updated.", "success");
      setEditingId(null);
      await fetchAttendees();
      router.refresh();
    } catch {
      const msg = "Failed to save changes.";
      setEditError(msg);
      showToast(msg, "error");
    } finally {
      setSavingEdit(false);
    }
  }

  // Single certificate type checkbox toggle
  async function handleToggleCertType(
    row: AttendeeListItem,
    certType: CertificateTypeRow,
    nextAssigned: boolean,
  ) {
    const existingCert = row.certificates.find(
      (c) => c.certificateTypeId === certType.id,
    );

    if (!nextAssigned && existingCert && existingCert.downloadCount > 0) {
      const proceed = window.confirm(
        `${row.fullName} has already downloaded "${certType.label}" (${existingCert.downloadCount}×). Unassigning will delete this certificate record. Continue?`,
      );
      if (!proceed) return;
    }

    const key = `${row.id}:${certType.id}`;
    setTogglingKey(key);

    try {
      const res = await setAttendeeCertificateTypeAction({
        eventId,
        attendeeId: row.id,
        certificateTypeId: certType.id,
        assigned: nextAssigned,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        nextAssigned
          ? `Assigned "${certType.label}" to ${row.fullName}.`
          : `Unassigned "${certType.label}" from ${row.fullName}.`,
        "success",
      );
      await fetchAttendees();
      router.refresh();
    } catch {
      showToast("Failed to update certificate assignment.", "error");
    } finally {
      setTogglingKey(null);
    }
  }

  // Bulk assign / unassign
  async function handleBulkCertificateType(assigned: boolean) {
    if (!bulkTypeId || selectedIds.size === 0) return;

    setBulkAssigning(true);
    try {
      const res = await bulkSetCertificateTypeAction({
        eventId,
        attendeeIds: Array.from(selectedIds),
        certificateTypeId: bulkTypeId,
        assigned,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      const targetType = certificateTypes.find((t) => t.id === bulkTypeId);
      showToast(
        assigned
          ? `Assigned "${targetType?.label ?? "certificate"}" to ${res.affectedCount ?? 0} attendee(s).`
          : `Unassigned "${targetType?.label ?? "certificate"}" from ${res.affectedCount ?? 0} attendee(s).`,
        "success",
      );
      await fetchAttendees();
      router.refresh();
    } catch {
      showToast("Bulk update failed.", "error");
    } finally {
      setBulkAssigning(false);
    }
  }

  // Single delete confirm
  async function handleResetDownloads(row: AttendeeListItem) {
    setResettingAttendeeId(row.id);
    try {
      const res = await resetAttendeeDownloadsAction({
        eventId,
        attendeeId: row.id,
      });
      if (res.error) {
        showToast(res.error, "error");
        return;
      }
      showToast(
        `Reset download count for ${row.fullName}. They can now download again.`,
        "success",
      );
      await fetchAttendees();
      router.refresh();
    } catch {
      showToast("Failed to reset downloads.", "error");
    } finally {
      setResettingAttendeeId(null);
    }
  }

  async function handleConfirmSingleDelete() {
    if (!deletingAttendee) return;
    setDeletingSingle(true);

    try {
      const res = await deleteAttendeeAction({
        eventId,
        attendeeId: deletingAttendee.id,
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(`Deleted "${deletingAttendee.fullName}".`, "success");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deletingAttendee.id);
        return next;
      });
      setDeletingAttendee(null);
      await fetchAttendees();
      router.refresh();
    } catch {
      showToast("Failed to delete attendee.", "error");
    } finally {
      setDeletingSingle(false);
    }
  }

  // Bulk delete confirm
  async function handleConfirmBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);

    try {
      const res = await bulkDeleteAttendeesAction({
        eventId,
        attendeeIds: Array.from(selectedIds),
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        `Deleted ${res.affectedCount ?? selectedIds.size} attendee(s).`,
        "success",
      );
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      setPage(1);
      await fetchAttendees();
      router.refresh();
    } catch {
      showToast("Bulk delete failed.", "error");
    } finally {
      setBulkDeleting(false);
    }
  }

  const atEventLimit =
    quota.maxCertificatesPerEvent !== null &&
    quota.eventCertsUsed >= quota.maxCertificatesPerEvent;
  const atOrgLimit =
    quota.maxCertificatesTotal !== null &&
    quota.orgCertsUsed >= quota.maxCertificatesTotal;
  const atAnyLimit = atEventLimit || atOrgLimit;

  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(totalCount, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Top header & quota summary */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Attendees ({totalCount})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Lookup key: <strong className="text-slate-700">{identifierLabel}</strong>{" "}
              ({uppercaseIdentifiers ? "trimmed & uppercased" : "trimmed, case preserved"})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
              Event certs:{" "}
              <strong className="text-slate-900">
                {quota.eventCertsUsed} / {quota.maxCertificatesPerEvent ?? "∞"}
              </strong>
            </span>
            <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
              Org total:{" "}
              <strong className="text-slate-900">
                {quota.orgCertsUsed} / {quota.maxCertificatesTotal ?? "∞"}
              </strong>{" "}
              ({quota.planName})
            </span>
            <a
              href={`/api/dashboard/events/${eventId}/import/sample-csv`}
              download
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs transition hover:bg-slate-50"
            >
              ⬇ Sample CSV
            </a>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setImportModalOpen(true)}
            >
              📤 Import CSV / Excel
            </Button>
            <Button
              variant={addFormOpen ? "secondary" : "primary"}
              size="sm"
              onClick={() => {
                setAddError(null);
                setAddFormOpen((prev) => !prev);
              }}
            >
              {addFormOpen ? "Close Form" : "+ Add Attendee"}
            </Button>
          </div>
        </div>

        {/* Add Attendee Form */}
        {addFormOpen && (
          <form
            onSubmit={handleAddAttendee}
            className="mt-5 space-y-4 border-t border-slate-100 pt-5"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                id="add-attendee-identifier"
                label={`${identifierLabel} *`}
                placeholder={
                  uppercaseIdentifiers ? "e.g. FA24-BSE-001" : "e.g. ID or email"
                }
                value={newIdentifier}
                onChange={(e) => setNewIdentifier(e.target.value)}
                required
                maxLength={100}
                disabled={adding}
              />
              <Input
                id="add-attendee-name"
                label="Full name *"
                placeholder="Official recipient name"
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                required
                maxLength={200}
                disabled={adding}
              />
              <Input
                id="add-attendee-email"
                type="email"
                label="Email (optional)"
                placeholder="attendee@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={adding}
              />
              <Input
                id="add-attendee-note"
                label="Note (optional)"
                placeholder="e.g. Speaker, VIP, Late reg"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                maxLength={1000}
                disabled={adding}
              />
            </div>

            {certificateTypes.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold text-slate-700">
                  Assign certificate types:
                </p>
                <div className="flex flex-wrap gap-3">
                  {certificateTypes.map((ct) => {
                    const checked = newTypeIds.includes(ct.id);
                    return (
                      <label
                        key={ct.id}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...newTypeIds, ct.id]
                              : newTypeIds.filter((id) => id !== ct.id);
                            setNewTypeIds(next);
                          }}
                          disabled={adding}
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>{ct.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {addError && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700">
                {addError}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setAddFormOpen(false)}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={adding}>
                Add Attendee
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Plan limit warning banner */}
      {atAnyLimit && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900">
          <div>
            <strong>Certificate quota reached on {quota.planName} plan:</strong>{" "}
            {atEventLimit
              ? `This event has issued ${quota.eventCertsUsed}/${quota.maxCertificatesPerEvent} allowed certificates.`
              : `Your organization has issued ${quota.orgCertsUsed}/${quota.maxCertificatesTotal} total certificates.`}
          </div>
          <Link
            href="/dashboard/billing"
            className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
          >
            Upgrade Plan →
          </Link>
        </div>
      )}

      {/* Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex min-w-[240px] flex-1 items-center gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={`Search by ${identifierLabel.toLowerCase()}, name, email, or note...`}
            className="block w-full max-w-md rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:text-sm"
          />
          {searchInput && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchInput("")}
            >
              Clear
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value as "" | "csv" | "manual");
              setPage(1);
            }}
            aria-label="Filter by source"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">All sources</option>
            <option value="manual">Manual only</option>
            <option value="csv">CSV only</option>
          </select>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSortBy("created_at");
              setSortDir("desc");
              setPage(1);
            }}
          >
            Newest first
          </Button>
        </div>
      </div>

      {/* Bulk Action Bar when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/90 px-5 py-3 shadow-xs">
          <div className="flex items-center gap-3 text-xs">
            <span className="font-bold text-indigo-950">
              {selectedIds.size} attendee{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="font-semibold text-indigo-700 underline hover:text-indigo-900"
            >
              Clear selection
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {certificateTypes.length > 0 && (
              <>
                <select
                  value={bulkTypeId}
                  onChange={(e) => setBulkTypeId(e.target.value)}
                  disabled={bulkAssigning}
                  aria-label="Select certificate type for bulk assignment"
                  className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none"
                >
                  {certificateTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>
                      {ct.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  size="sm"
                  loading={bulkAssigning}
                  onClick={() => handleBulkCertificateType(true)}
                >
                  Assign Type
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={bulkAssigning}
                  onClick={() => handleBulkCertificateType(false)}
                >
                  Unassign
                </Button>
              </>
            )}

            <Button
              variant="danger"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete Selected ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

      {/* Load error */}
      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-medium text-red-700">
          {loadError}
        </div>
      )}

      {/* Attendees Table */}
      {!loading && totalCount === 0 && !debouncedSearch && !sourceFilter ? (
        <EmptyState
          icon="👥"
          title="No attendees added yet"
          description={`Import attendees from any CSV or Excel (.xlsx) spreadsheet, or add them manually. Each attendee is uniquely identified by ${identifierLabel}.`}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <Button
                variant="primary"
                onClick={() => setImportModalOpen(true)}
              >
                📤 Import CSV / Excel
              </Button>
              <Button
                variant="secondary"
                onClick={() => setAddFormOpen(true)}
              >
                + Add Manually
              </Button>
            </div>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allCurrentPageSelected}
                      onChange={toggleSelectAllPage}
                      aria-label="Select all attendees on this page"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("identifier")}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-slate-900"
                    >
                      <span>{identifierLabel}</span>
                      {sortIndicator("identifier")}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("full_name")}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-slate-900"
                    >
                      <span>Name</span>
                      {sortIndicator("full_name")}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("email")}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-slate-900"
                    >
                      <span>Email</span>
                      {sortIndicator("email")}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Certificate Types
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("downloads")}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-slate-900"
                    >
                      <span>Downloads</span>
                      {sortIndicator("downloads")}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("source")}
                      className="inline-flex items-center gap-1 font-semibold uppercase hover:text-slate-900"
                    >
                      <span>Source</span>
                      {sortIndicator("source")}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Note
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {loading ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-6 py-10 text-center text-xs font-medium text-slate-500"
                    >
                      Loading attendees...
                    </td>
                  </tr>
                ) : attendees.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-6 py-10 text-center text-xs text-slate-500"
                    >
                      No attendees match your current search or filter.
                    </td>
                  </tr>
                ) : (
                  attendees.map((row) => {
                    const isEditing = editingId === row.id;
                    const isSelected = selectedIds.has(row.id);

                    return (
                      <tr
                        key={row.id}
                        className={
                          isSelected
                            ? "bg-indigo-50/40"
                            : "transition hover:bg-slate-50/70"
                        }
                      >
                        {/* Select checkbox */}
                        <td className="px-4 py-3 align-top">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectRow(row.id)}
                            aria-label={`Select ${row.fullName}`}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>

                        {/* Identifier */}
                        <td className="px-4 py-3 align-top font-mono text-xs font-semibold text-slate-900">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editIdentifier}
                              onChange={(e) => setEditIdentifier(e.target.value)}
                              disabled={savingEdit}
                              className="w-32 rounded-lg border border-indigo-300 bg-white px-2 py-1 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                            />
                          ) : (
                            row.identifier
                          )}
                        </td>

                        {/* Full Name */}
                        <td className="px-4 py-3 align-top">
                          {isEditing ? (
                            <div className="space-y-1">
                              <input
                                type="text"
                                value={editFullName}
                                onChange={(e) => setEditFullName(e.target.value)}
                                disabled={savingEdit}
                                className="w-44 rounded-lg border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:border-indigo-500 focus:outline-none"
                              />
                              {editError && (
                                <p className="max-w-[220px] text-[11px] font-medium text-red-600">
                                  {editError}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="font-medium text-slate-900">
                              {row.fullName}
                            </span>
                          )}
                        </td>

                        {/* Email */}
                        <td className="px-4 py-3 align-top text-xs text-slate-600">
                          {isEditing ? (
                            <input
                              type="email"
                              value={editEmail}
                              onChange={(e) => setEditEmail(e.target.value)}
                              placeholder="email@example.com"
                              disabled={savingEdit}
                              className="w-44 rounded-lg border border-indigo-300 bg-white px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
                            />
                          ) : (
                            row.email || <span className="text-slate-300">—</span>
                          )}
                        </td>

                        {/* Certificate Types (checkbox per type) */}
                        <td className="px-4 py-3 align-top">
                          {certificateTypes.length === 0 ? (
                            <span className="text-xs text-slate-400">
                              No types
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {certificateTypes.map((ct) => {
                                const cert = row.certificates.find(
                                  (c) => c.certificateTypeId === ct.id,
                                );
                                const assigned = Boolean(cert);
                                const busy = togglingKey === `${row.id}:${ct.id}`;

                                return (
                                  <label
                                    key={ct.id}
                                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                                      assigned
                                        ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                                    } ${busy ? "opacity-60" : ""}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={assigned}
                                      disabled={busy}
                                      onChange={(e) =>
                                        void handleToggleCertType(
                                          row,
                                          ct,
                                          e.target.checked,
                                        )
                                      }
                                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    <span>{ct.label}</span>
                                    {cert && cert.downloadCount > 0 && (
                                      <span
                                        title={`Downloaded ${cert.downloadCount} time(s)`}
                                        className="rounded bg-emerald-100 px-1 py-0.2 text-[10px] font-bold text-emerald-800"
                                      >
                                        ✓{cert.downloadCount}
                                      </span>
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </td>

                        {/* Downloads */}
                        <td className="px-4 py-3 align-top">
                          {row.totalDownloads > 0 ? (
                            <div className="inline-flex items-center gap-1.5">
                              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                                ✓ {row.totalDownloads}
                              </span>
                              <button
                                type="button"
                                disabled={resettingAttendeeId === row.id}
                                onClick={() => void handleResetDownloads(row)}
                                title="Reset download limit for this attendee"
                                className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                              >
                                {resettingAttendeeId === row.id
                                  ? "..."
                                  : "Reset"}
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">0</span>
                          )}
                        </td>

                        {/* Source */}
                        <td className="px-4 py-3 align-top">
                          <span
                            className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase ${
                              row.source === "csv"
                                ? "bg-sky-50 text-sky-700 ring-1 ring-sky-200"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {row.source}
                          </span>
                        </td>

                        {/* Note */}
                        <td className="max-w-[180px] px-4 py-3 align-top text-xs text-slate-600">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editNote}
                              onChange={(e) => setEditNote(e.target.value)}
                              placeholder="Note..."
                              disabled={savingEdit}
                              className="w-36 rounded-lg border border-indigo-300 bg-white px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
                            />
                          ) : row.note ? (
                            <span className="line-clamp-2" title={row.note}>
                              {row.note}
                            </span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3 text-right align-top whitespace-nowrap">
                          {isEditing ? (
                            <div className="inline-flex items-center gap-1.5">
                              <Button
                                variant="primary"
                                size="sm"
                                loading={savingEdit}
                                onClick={() => void saveInlineEdit(row.id)}
                              >
                                Save
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={savingEdit}
                                onClick={cancelInlineEdit}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => beginInlineEdit(row)}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                                onClick={() => setDeletingAttendee(row)}
                              >
                                Delete
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Server-side Pagination Footer (50 per page) */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs text-slate-600 sm:px-6">
            <span>
              Showing <strong className="text-slate-900">{rangeStart}</strong>–
              <strong className="text-slate-900">{rangeEnd}</strong> of{" "}
              <strong className="text-slate-900">{totalCount}</strong> attendee
              {totalCount === 1 ? "" : "s"} ({PAGE_SIZE} per page)
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

      {/* Single Attendee Delete ConfirmDialog */}
      <ConfirmDialog
        open={Boolean(deletingAttendee)}
        onClose={() => !deletingSingle && setDeletingAttendee(null)}
        onConfirm={() => void handleConfirmSingleDelete()}
        title={`Delete attendee "${deletingAttendee?.fullName ?? ""}"?`}
        description={`This will permanently remove ${deletingAttendee?.fullName ?? "this attendee"} (${deletingAttendee?.identifier ?? ""}), their assigned certificate records, and download history.`}
        confirmLabel="Delete Attendee"
        danger
        loading={deletingSingle}
      />

      {/* Bulk Delete ConfirmDialog */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => !bulkDeleting && setBulkDeleteOpen(false)}
        onConfirm={() => void handleConfirmBulkDelete()}
        title={`Delete ${selectedIds.size} selected attendee${selectedIds.size === 1 ? "" : "s"}?`}
        description={`This will permanently delete ${selectedIds.size} attendee(s), all of their issued certificates, and their download logs for this event. This cannot be undone.`}
        confirmLabel={`Delete ${selectedIds.size} Attendee${selectedIds.size === 1 ? "" : "s"}`}
        danger
        loading={bulkDeleting}
      />

      {/* Multi-step CSV / XLSX Import Wizard Modal */}
      <ImportWizardModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImportComplete={() => {
          void fetchAttendees();
          router.refresh();
        }}
        eventId={eventId}
        identifierLabel={identifierLabel}
        certificateTypes={certificateTypes}
      />
    </div>
  );
}
