"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Modal, useToast } from "@/components/ui";
import type { CertificateTypeRow } from "@/lib/dashboard-data";
import type {
  ColumnMappingConfig,
  ImportValidationReport,
} from "@/lib/tabular-import";

type WizardStep = "upload" | "map" | "preview" | "importing" | "done";

interface ParsedUploadState {
  fileName: string;
  format: "csv" | "xlsx";
  encoding: string;
  delimiter: string;
  headers: string[];
  sampleRows: Array<{ rowNumber: number; cells: string[] }>;
  rows: Array<{ rowNumber: number; cells: string[] }>;
  totalDataRows: number;
}

interface ImportDoneSummary {
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  certificatesCreatedCount: number;
}

export default function ImportWizardModal({
  open,
  onClose,
  onImportComplete,
  eventId,
  identifierLabel,
  certificateTypes,
}: {
  open: boolean;
  onClose: () => void;
  onImportComplete: () => void;
  eventId: string;
  identifierLabel: string;
  certificateTypes: CertificateTypeRow[];
}) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<WizardStep>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 -> 2 parsed sheet state
  const [parsed, setParsed] = useState<ParsedUploadState | null>(null);
  const [mapping, setMapping] = useState<ColumnMappingConfig>({
    identifierCol: null,
    fullNameCol: null,
    emailCol: null,
    noteCol: null,
    certTypesCol: null,
    perTypeCols: {},
    defaultTypeIds: certificateTypes[0] ? [certificateTypes[0].id] : [],
  });

  // Step 3 validation preview state
  const [report, setReport] = useState<ImportValidationReport | null>(null);
  const [errorCsv, setErrorCsv] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<"skip" | "update">("skip");

  // Step 4 progress & completion state
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [doneSummary, setDoneSummary] = useState<ImportDoneSummary | null>(
    null,
  );

  function resetWizard() {
    setStep("upload");
    setBusy(false);
    setError(null);
    setParsed(null);
    setReport(null);
    setErrorCsv(null);
    setDuplicateMode("skip");
    setProgressPercent(0);
    setProgressMessage("");
    setDoneSummary(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    if (busy && step === "importing") return;
    resetWizard();
    onClose();
  }

  async function handleFileChosen(file: File) {
    setError(null);
    setBusy(true);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const res = await fetch(
        `/api/dashboard/events/${eventId}/import/parse`,
        {
          method: "POST",
          body: formData,
        },
      );

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        fileName?: string;
        format?: "csv" | "xlsx";
        encoding?: string;
        delimiter?: string;
        headers?: string[];
        sampleRows?: Array<{ rowNumber: number; cells: string[] }>;
        rows?: Array<{ rowNumber: number; cells: string[] }>;
        totalDataRows?: number;
        suggestedMapping?: ColumnMappingConfig;
      };

      if (!res.ok || data.error || !data.headers || !data.rows) {
        setError(data.error || "Failed to parse uploaded file.");
        return;
      }

      setParsed({
        fileName: data.fileName || file.name,
        format: data.format || "csv",
        encoding: data.encoding || "UTF-8",
        delimiter: data.delimiter || "Comma (,)",
        headers: data.headers,
        sampleRows: data.sampleRows || [],
        rows: data.rows,
        totalDataRows: data.totalDataRows || data.rows.length,
      });

      if (data.suggestedMapping) {
        setMapping(data.suggestedMapping);
      }

      setStep("map");
    } catch {
      setError("Network error while uploading file.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleRunValidationPreview() {
    if (!parsed) return;
    if (mapping.identifierCol === null || mapping.fullNameCol === null) {
      setError(
        `Please map both "${identifierLabel}" and "Full Name" columns.`,
      );
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const res = await fetch(
        `/api/dashboard/events/${eventId}/import/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows: parsed.rows,
            mapping,
          }),
        },
      );

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        report?: ImportValidationReport;
        errorCsv?: string | null;
      };

      if (!res.ok || data.error || !data.report) {
        setError(data.error || "Validation failed.");
        return;
      }

      setReport(data.report);
      setErrorCsv(data.errorCsv ?? null);
      setStep("preview");
    } catch {
      setError("Network error while validating rows.");
    } finally {
      setBusy(false);
    }
  }

  function handleDownloadErrorCsv() {
    if (!errorCsv) return;
    const blob = new Blob(["\uFEFF" + errorCsv], {
      type: "text/csv; charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${parsed?.fileName.replace(/\.[^.]+$/, "") || "rows"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleConfirmImport() {
    if (!report) return;
    const activeQuota = report.quotaByMode[duplicateMode];
    if (!activeQuota.withinLimit) {
      setError(activeQuota.limitError || "Import exceeds your current plan limit.");
      return;
    }

    const actionableCount =
      duplicateMode === "skip"
        ? activeQuota.newAttendees
        : activeQuota.newAttendees + activeQuota.updatedAttendees;

    if (actionableCount === 0 && report.preparedRows.length === 0) {
      setError("There are no valid rows to import.");
      return;
    }

    setError(null);
    setBusy(true);
    setStep("importing");
    setProgressPercent(8);
    setProgressMessage("Starting transactional import...");

    try {
      const res = await fetch(
        `/api/dashboard/events/${eventId}/import/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preparedRows: report.preparedRows,
            mode: duplicateMode,
          }),
        },
      );

      if (!res.ok || !res.body) {
        const errJson = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(errJson.error || "Import failed.");
        setStep("preview");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf("\n");

          if (!line) continue;
          const msg = JSON.parse(line) as {
            type: "progress" | "done" | "error";
            percent?: number;
            message?: string;
            error?: string;
            insertedCount?: number;
            updatedCount?: number;
            skippedCount?: number;
            certificatesCreatedCount?: number;
          };

          if (msg.type === "progress") {
            if (typeof msg.percent === "number") {
              setProgressPercent(msg.percent);
            }
            if (msg.message) {
              setProgressMessage(msg.message);
            }
          } else if (msg.type === "error") {
            setError(msg.error || "Import failed.");
            setStep("preview");
            setBusy(false);
            return;
          } else if (msg.type === "done") {
            setProgressPercent(100);
            setDoneSummary({
              insertedCount: msg.insertedCount ?? 0,
              updatedCount: msg.updatedCount ?? 0,
              skippedCount: msg.skippedCount ?? 0,
              certificatesCreatedCount: msg.certificatesCreatedCount ?? 0,
            });
            setStep("done");
            showToast(
              `Import complete: ${msg.insertedCount ?? 0} added, ${msg.updatedCount ?? 0} updated.`,
              "success",
            );
            onImportComplete();
          }
        }
      }
    } catch {
      setError("Network error while importing attendees.");
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  function renderColSelect(
    id: string,
    label: string,
    value: number | null,
    onChange: (colIdx: number | null) => void,
    required = false,
    emptyLabel = "— Do not import —",
  ) {
    if (!parsed) return null;
    return (
      <div>
        <label
          htmlFor={id}
          className="mb-1 block text-xs font-semibold text-slate-700"
        >
          {label} {required && <span className="text-red-600">*</span>}
        </label>
        <select
          id={id}
          value={value === null ? "" : String(value)}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
          className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          <option value="">
            {required ? "— Select column —" : emptyLabel}
          </option>
          {parsed.headers.map((h, idx) => (
            <option key={`${idx}-${h}`} value={String(idx)}>
              Col {idx + 1}: {h}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const activeQuota = report ? report.quotaByMode[duplicateMode] : null;
  const canConfirmImport =
    report !== null &&
    activeQuota !== null &&
    activeQuota.withinLimit &&
    report.preparedRows.length > 0 &&
    (duplicateMode === "update" || activeQuota.newAttendees > 0);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import Attendees (CSV or Excel .xlsx)"
      description="Upload up to 5,000 rows, map columns, review validation & duplicates, and import atomically."
      maxWidthClass="max-w-4xl"
    >
      <div className="max-h-[75vh] space-y-5 overflow-y-auto pr-1">
        {/* Step indicator pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          {(
            [
              { key: "upload", label: "1. Upload File" },
              { key: "map", label: "2. Map Columns" },
              { key: "preview", label: "3. Validate & Preview" },
              { key: "done", label: "4. Import" },
            ] as const
          ).map((s) => {
            const active =
              step === s.key || (s.key === "done" && step === "importing");
            return (
              <span
                key={s.key}
                className={`rounded-full px-3 py-1 ${
                  active
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {s.label}
              </span>
            );
          })}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
            {error}
          </div>
        )}

        {/* STEP 1: UPLOAD */}
        {step === "upload" && (
          <div className="space-y-4">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file && !busy) void handleFileChosen(file);
              }}
              onClick={() => !busy && fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/70 px-6 py-12 text-center transition hover:border-indigo-400 hover:bg-indigo-50/30"
            >
              <span className="mb-2 text-3xl" aria-hidden="true">
                📊
              </span>
              <p className="text-sm font-bold text-slate-900">
                {busy
                  ? "Detecting encoding & parsing rows..."
                  : "Click or drag a .csv or .xlsx file here"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Supports arbitrary column headers, UTF-8 / BOM / Excel CSVs, custom delimiters (comma, semicolon, tab, pipe), and Excel (.xlsx) up to 5,000 rows.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileChosen(file);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
              <span>
                Need a starting template? Download a sample CSV pre-formatted for{" "}
                <strong className="text-slate-900">{identifierLabel}</strong>.
              </span>
              <a
                href={`/api/dashboard/events/${eventId}/import/sample-csv`}
                download
                className="font-semibold text-indigo-600 hover:text-indigo-500"
              >
                ⬇ Download Sample CSV
              </a>
            </div>
          </div>
        )}

        {/* STEP 2: COLUMN MAPPING + FIRST 10 ROWS */}
        {step === "map" && parsed && (
          <div className="space-y-5">
            {/* Detected file metadata */}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
              <span>
                File: <strong>{parsed.fileName}</strong>
              </span>
              <span>·</span>
              <span>
                Format:{" "}
                <strong className="uppercase">{parsed.format}</strong>
              </span>
              <span>·</span>
              <span>
                Encoding: <strong>{parsed.encoding}</strong>
              </span>
              <span>·</span>
              <span>
                Delimiter: <strong>{parsed.delimiter}</strong>
              </span>
              <span>·</span>
              <span>
                Rows:{" "}
                <strong>{parsed.totalDataRows.toLocaleString()}</strong>
              </span>
            </div>

            {/* Column mapping dropdowns */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {renderColSelect(
                "map-identifier",
                identifierLabel,
                mapping.identifierCol,
                (idx) => setMapping((m) => ({ ...m, identifierCol: idx })),
                true,
              )}
              {renderColSelect(
                "map-fullname",
                "Full Name",
                mapping.fullNameCol,
                (idx) => setMapping((m) => ({ ...m, fullNameCol: idx })),
                true,
              )}
              {renderColSelect(
                "map-email",
                "Email (optional)",
                mapping.emailCol,
                (idx) => setMapping((m) => ({ ...m, emailCol: idx })),
              )}
              {renderColSelect(
                "map-note",
                "Note (optional)",
                mapping.noteCol,
                (idx) => setMapping((m) => ({ ...m, noteCol: idx })),
              )}
              {renderColSelect(
                "map-cert-types",
                "Certificate Types column",
                mapping.certTypesCol,
                (idx) => setMapping((m) => ({ ...m, certTypesCol: idx })),
                false,
                "— Use default types below —",
              )}
            </div>

            {/* Default certificate types + optional per-type Yes/No column mapping */}
            {certificateTypes.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                <div>
                  <p className="text-xs font-bold text-slate-800">
                    Default certificate types (assigned when no type column is mapped or cell is blank)
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2.5">
                    {certificateTypes.map((ct) => {
                      const checked = mapping.defaultTypeIds.includes(ct.id);
                      return (
                        <label
                          key={ct.id}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...mapping.defaultTypeIds, ct.id]
                                : mapping.defaultTypeIds.filter(
                                    (id) => id !== ct.id,
                                  );
                              setMapping((m) => ({
                                ...m,
                                defaultTypeIds: next,
                              }));
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                          />
                          <span>{ct.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {certificateTypes.length > 1 && (
                  <div className="border-t border-slate-200/70 pt-3">
                    <p className="mb-2 text-[11px] font-semibold text-slate-600">
                      Optional: map Yes/No flag columns for extra certificate types (e.g. Society Member / Appreciation):
                    </p>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {certificateTypes.map((ct) =>
                        renderColSelect(
                          `map-per-type-${ct.id}`,
                          `${ct.label} (Yes/1/True column)`,
                          mapping.perTypeCols?.[ct.id] ?? null,
                          (idx) =>
                            setMapping((m) => ({
                              ...m,
                              perTypeCols: {
                                ...(m.perTypeCols ?? {}),
                                [ct.id]: idx,
                              },
                            })),
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* First 10 rows preview */}
            <div>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                First {parsed.sampleRows.length} rows preview
              </h4>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                  <thead className="bg-slate-50 font-semibold text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Row #</th>
                      {parsed.headers.map((h, i) => {
                        const mappedBadge =
                          mapping.identifierCol === i
                            ? identifierLabel
                            : mapping.fullNameCol === i
                              ? "Full Name"
                              : mapping.emailCol === i
                                ? "Email"
                                : mapping.noteCol === i
                                  ? "Note"
                                  : mapping.certTypesCol === i
                                    ? "Cert Types"
                                    : null;
                        return (
                          <th key={`${i}-${h}`} className="px-3 py-2 whitespace-nowrap">
                            <div>{h}</div>
                            {mappedBadge && (
                              <span className="mt-0.5 inline-block rounded bg-indigo-100 px-1.5 py-0.2 text-[10px] font-bold text-indigo-800">
                                → {mappedBadge}
                              </span>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                    {parsed.sampleRows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-400">
                          {r.rowNumber}
                        </td>
                        {r.cells.map((cell, ci) => (
                          <td
                            key={ci}
                            className="max-w-[180px] truncate px-3 py-2"
                            title={cell}
                          >
                            {cell || <span className="text-slate-300">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={resetWizard}
                disabled={busy}
              >
                ← Choose Different File
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() => void handleRunValidationPreview()}
              >
                Validate &amp; Preview →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: VALIDATION PREVIEW */}
        {step === "preview" && report && activeQuota && (
          <div className="space-y-5">
            {/* Summary stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
                <p className="text-[11px] font-semibold uppercase text-emerald-800">
                  Valid
                </p>
                <p className="mt-1 text-xl font-bold text-emerald-950">
                  {report.validCount.toLocaleString()}
                </p>
              </div>

              <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3">
                <p className="text-[11px] font-semibold uppercase text-indigo-800">
                  New in Event
                </p>
                <p className="mt-1 text-xl font-bold text-indigo-950">
                  {report.newInEventCount.toLocaleString()}
                </p>
              </div>

              <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3">
                <p className="text-[11px] font-semibold uppercase text-sky-800">
                  Already Existing
                </p>
                <p className="mt-1 text-xl font-bold text-sky-950">
                  {report.existingInEventCount.toLocaleString()}
                </p>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                <p className="text-[11px] font-semibold uppercase text-amber-800">
                  Duplicates in File
                </p>
                <p className="mt-1 text-xl font-bold text-amber-950">
                  {report.duplicateInFileCount.toLocaleString()}
                </p>
              </div>

              <div className="rounded-xl border border-red-200 bg-red-50/70 p-3">
                <p className="text-[11px] font-semibold uppercase text-red-800">
                  Invalid Rows
                </p>
                <p className="mt-1 text-xl font-bold text-red-950">
                  {report.invalidCount.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Existing rows handling mode: Skip existing vs Update existing names */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
              <p className="mb-2 text-xs font-bold text-slate-800">
                How should existing attendees in this event ({report.existingInEventCount}) be handled?
              </p>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setDuplicateMode("skip")}
                  className={`rounded-xl border p-3 text-left transition ${
                    duplicateMode === "skip"
                      ? "border-indigo-600 bg-white ring-2 ring-indigo-500/20"
                      : "border-slate-200 bg-white/70 hover:bg-white"
                  }`}
                >
                  <p className="text-xs font-bold text-slate-900">
                    Skip existing ({report.quotaByMode.skip.skippedAttendees} skipped)
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Keep existing names unchanged; only insert {report.quotaByMode.skip.newAttendees} brand-new attendee(s).
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setDuplicateMode("update")}
                  className={`rounded-xl border p-3 text-left transition ${
                    duplicateMode === "update"
                      ? "border-indigo-600 bg-white ring-2 ring-indigo-500/20"
                      : "border-slate-200 bg-white/70 hover:bg-white"
                  }`}
                >
                  <p className="text-xs font-bold text-slate-900">
                    Update existing names ({report.quotaByMode.update.updatedAttendees} updated)
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Update full name (and non-empty email/note) and attach any newly mapped certificate types.
                  </p>
                </button>
              </div>
            </div>

            {/* Plan limit pre-check report */}
            {!activeQuota.withinLimit ? (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-xs text-red-900">
                <p className="font-bold">⚠️ Plan limit would be exceeded:</p>
                <p className="mt-1">{activeQuota.limitError}</p>
                <Link
                  href="/dashboard/billing"
                  className="mt-2 inline-block font-bold text-indigo-700 underline"
                >
                  Upgrade your plan in Billing →
                </Link>
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-xs text-emerald-900">
                <strong>Plan check passed:</strong> This import will add{" "}
                <strong>{activeQuota.newAttendees}</strong> new attendee(s) and issue{" "}
                <strong>{activeQuota.newCertificates}</strong> new certificate(s).
              </div>
            )}

            {/* Invalid & duplicate-in-file issues list + Downloadable Error CSV */}
            {report.issues.length > 0 && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-bold text-red-800">
                    Skipped file issues ({report.issues.length} row
                    {report.issues.length === 1 ? "" : "s"} — will not be imported)
                  </h4>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleDownloadErrorCsv}
                  >
                    ⬇ Download Error CSV ({report.issues.length})
                  </Button>
                </div>

                <div className="max-h-48 overflow-y-auto rounded-xl border border-red-200">
                  <table className="min-w-full divide-y divide-red-100 text-left text-xs">
                    <thead className="bg-red-50/80 font-semibold text-red-900">
                      <tr>
                        <th className="px-3 py-2">Row #</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">{identifierLabel}</th>
                        <th className="px-3 py-2">Full Name</th>
                        <th className="px-3 py-2">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100 bg-white text-slate-700">
                      {report.issues.slice(0, 100).map((iss, idx) => (
                        <tr key={`${iss.rowNumber}-${idx}`}>
                          <td className="px-3 py-1.5 font-mono text-[11px] font-bold text-slate-900">
                            {iss.rowNumber}
                          </td>
                          <td className="px-3 py-1.5">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                iss.category === "duplicate_in_file"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-red-100 text-red-800"
                              }`}
                            >
                              {iss.category === "duplicate_in_file"
                                ? "Duplicate"
                                : "Invalid"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-[11px]">
                            {iss.identifier || "—"}
                          </td>
                          <td className="px-3 py-1.5">{iss.fullName || "—"}</td>
                          <td className="px-3 py-1.5 text-red-700">
                            {iss.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.issues.length > 100 && (
                  <p className="text-[11px] text-slate-500">
                    Showing first 100 of {report.issues.length} issues. Download the Error CSV for the complete list.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setStep("map")}
                disabled={busy}
              >
                ← Back to Column Mapping
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canConfirmImport || busy}
                onClick={() => void handleConfirmImport()}
              >
                Confirm &amp; Import ({report.validCount.toLocaleString()} Valid Rows)
              </Button>
            </div>
          </div>
        )}

        {/* STEP 4A: PROGRESS */}
        {step === "importing" && (
          <div className="space-y-4 py-8 text-center">
            <p className="text-sm font-bold text-slate-900">
              {progressMessage || "Importing attendees..."}
            </p>
            <div className="mx-auto h-3 w-full max-w-md overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="font-mono text-xs text-slate-500">
              {progressPercent}%
            </p>
          </div>
        )}

        {/* STEP 4B: DONE */}
        {step === "done" && doneSummary && (
          <div className="space-y-5 py-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
              ✓
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                Import Completed Successfully
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                All batches were committed inside a single transaction and recorded in your audit log.
              </p>
            </div>

            <div className="mx-auto grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">New Added</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {doneSummary.insertedCount.toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">Updated</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {doneSummary.updatedCount.toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">Skipped</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {doneSummary.skippedCount.toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] text-slate-500">Certs Issued</p>
                <p className="mt-1 text-lg font-bold text-indigo-700">
                  {doneSummary.certificatesCreatedCount.toLocaleString()}
                </p>
              </div>
            </div>

            <div>
              <Button variant="primary" onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
