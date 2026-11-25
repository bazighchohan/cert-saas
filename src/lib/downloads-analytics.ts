import Papa from "papaparse";
import * as XLSX from "xlsx";

export type DownloadStatusFilter = "all" | "downloaded" | "not_downloaded";

export interface RawAttendeeCertForAnalytics {
  id: string;
  certificateTypeId: string;
  certificateTypeLabel: string;
  downloadCount: number;
  verifyCode: string;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
}

export interface RawAttendeeForAnalytics {
  id: string;
  identifier: string;
  fullName: string;
  email: string | null;
  source: "csv" | "manual";
  note: string | null;
  issueNote: string | null;
  createdAt: string;
  certificates: RawAttendeeCertForAnalytics[];
}

export interface RawDownloadLogEntry {
  id: number | string;
  attendeeCertificateId: string;
  certificateTypeId: string;
  downloadedAt: string;
  ipHash: string | null;
}

export interface ComputedDownloadRow {
  id: string;
  identifier: string;
  fullName: string;
  email: string | null;
  source: "csv" | "manual";
  note: string | null;
  issueNote: string | null;
  hasDownloaded: boolean;
  relevantDownloads: number;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
  certificates: RawAttendeeCertForAnalytics[];
}

export interface DailyDownloadPoint {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Nov 25"
  downloads: number;
}

export interface DownloadsAnalyticsSummary {
  totalAttendees: number;
  downloadedCount: number;
  notDownloadedCount: number;
  completionPct: number;
  totalLogDownloads: number;
  pendingEmails: string[];
  dailySeries: DailyDownloadPoint[];
  filteredRows: ComputedDownloadRow[];
}

/**
 * Pure, deterministic analytics computation over an event's attendees and download_log.
 * Guarantees `totalAttendees === downloadedCount + notDownloadedCount`.
 */
export function computeDownloadsAnalytics(params: {
  attendees: RawAttendeeForAnalytics[];
  downloadLogs: RawDownloadLogEntry[];
  statusFilter: DownloadStatusFilter;
  certTypeIdFilter?: string | null;
  search?: string | null;
  referenceTodayIso?: string;
}): DownloadsAnalyticsSummary {
  const {
    attendees,
    downloadLogs,
    statusFilter,
    certTypeIdFilter,
    search,
    referenceTodayIso,
  } = params;

  const typeFilter = certTypeIdFilter?.trim() || "";

  // 1. Scope attendees to certTypeIdFilter (if selected) and compute per-attendee download metrics
  const scopedRows: ComputedDownloadRow[] = [];

  for (const att of attendees) {
    const relevantCerts = typeFilter
      ? att.certificates.filter((c) => c.certificateTypeId === typeFilter)
      : att.certificates;

    // When filtering by a specific certificate type, only include attendees assigned that type
    if (typeFilter && relevantCerts.length === 0) {
      continue;
    }

    const relevantDownloads = relevantCerts.reduce(
      (sum, c) => sum + c.downloadCount,
      0,
    );
    const hasDownloaded = relevantDownloads > 0;

    let earliest: string | null = null;
    let latest: string | null = null;
    for (const c of relevantCerts) {
      if (c.firstDownloadedAt && (!earliest || c.firstDownloadedAt < earliest)) {
        earliest = c.firstDownloadedAt;
      }
      if (c.lastDownloadedAt && (!latest || c.lastDownloadedAt > latest)) {
        latest = c.lastDownloadedAt;
      }
    }

    scopedRows.push({
      id: att.id,
      identifier: att.identifier,
      fullName: att.fullName,
      email: att.email,
      source: att.source,
      note: att.note,
      issueNote: att.issueNote,
      hasDownloaded,
      relevantDownloads,
      firstDownloadedAt: earliest,
      lastDownloadedAt: latest,
      certificates: att.certificates,
    });
  }

  // 2. Summary KPI counts (computed across all scopedRows before text search / status table filter)
  const totalAttendees = scopedRows.length;
  let downloadedCount = 0;
  const pendingEmailSet = new Set<string>();

  for (const r of scopedRows) {
    if (r.hasDownloaded) {
      downloadedCount++;
    } else if (r.email && r.email.trim()) {
      pendingEmailSet.add(r.email.trim().toLowerCase());
    }
  }

  const notDownloadedCount = totalAttendees - downloadedCount;
  const completionPct =
    totalAttendees === 0
      ? 0
      : Number(((downloadedCount / totalAttendees) * 100).toFixed(1));

  // 3. Daily downloads time series from download_log
  const scopedLogs = typeFilter
    ? downloadLogs.filter((l) => l.certificateTypeId === typeFilter)
    : downloadLogs;

  const dailySeries = buildDailyDownloadsSeries(
    scopedLogs,
    referenceTodayIso,
  );

  // 4. Filter table rows by statusFilter + search term
  const q = (search ?? "").trim().toLowerCase();
  const filteredRows = scopedRows.filter((r) => {
    if (statusFilter === "downloaded" && !r.hasDownloaded) return false;
    if (statusFilter === "not_downloaded" && r.hasDownloaded) return false;

    if (q) {
      const hay = [
        r.identifier,
        r.fullName,
        r.email ?? "",
        r.note ?? "",
        r.issueNote ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });

  // Sort: downloaded rows show most recently downloaded first; pending rows sort by identifier
  filteredRows.sort((a, b) => {
    if (a.hasDownloaded !== b.hasDownloaded) {
      return a.hasDownloaded ? -1 : 1;
    }
    if (a.lastDownloadedAt && b.lastDownloadedAt) {
      return b.lastDownloadedAt.localeCompare(a.lastDownloadedAt);
    }
    return a.identifier.localeCompare(b.identifier);
  });

  return {
    totalAttendees,
    downloadedCount,
    notDownloadedCount,
    completionPct,
    totalLogDownloads: scopedLogs.length,
    pendingEmails: Array.from(pendingEmailSet),
    dailySeries,
    filteredRows,
  };
}

function formatShortMonthDay(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildDailyDownloadsSeries(
  logs: RawDownloadLogEntry[],
  referenceTodayIso?: string,
): DailyDownloadPoint[] {
  const countsByDay = new Map<string, number>();
  let minDay: string | null = null;
  let maxDay: string | null = null;

  for (const log of logs) {
    if (!log.downloadedAt) continue;
    const day = log.downloadedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
    if (!minDay || day < minDay) minDay = day;
    if (!maxDay || day > maxDay) maxDay = day;
  }

  const todayStr = (referenceTodayIso ?? new Date().toISOString()).slice(0, 10);
  const endDateStr = maxDay && maxDay > todayStr ? maxDay : todayStr;

  const endMs = Date.parse(`${endDateStr}T00:00:00Z`);
  // Show at least a 14-day window, or expand back to minDay (up to 90 days)
  const defaultStartMs = endMs - 13 * 86_400_000;
  const minMs = minDay ? Date.parse(`${minDay}T00:00:00Z`) : defaultStartMs;
  const cappedMinMs = Math.max(endMs - 89 * 86_400_000, Math.min(defaultStartMs, minMs));

  const points: DailyDownloadPoint[] = [];
  for (let ms = cappedMinMs; ms <= endMs; ms += 86_400_000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    points.push({
      date: day,
      label: formatShortMonthDay(day),
      downloads: countsByDay.get(day) ?? 0,
    });
  }

  return points;
}

function buildExportRecords(
  rows: ComputedDownloadRow[],
  identifierLabel: string,
): Array<Record<string, string | number>> {
  const idCol = identifierLabel.trim() || "Identifier";

  return rows.map((r) => ({
    [idCol]: r.identifier,
    "Full Name": r.fullName,
    Email: r.email ?? "",
    Status: r.hasDownloaded ? "Downloaded" : "Not Downloaded",
    "Certificate Types": r.certificates
      .map((c) => `${c.certificateTypeLabel} (${c.downloadCount})`)
      .join("; "),
    "Total Downloads": r.relevantDownloads,
    "First Downloaded At": r.firstDownloadedAt ?? "",
    "Last Downloaded At": r.lastDownloadedAt ?? "",
    "Verify Codes": r.certificates.map((c) => c.verifyCode).join("; "),
    Source: r.source.toUpperCase(),
    Note: r.note ?? "",
    "Issues / Name Correction Note": r.issueNote ?? "",
  }));
}

/**
 * Generates a UTF-8 BOM CSV string that opens cleanly in Microsoft Excel & Google Sheets.
 */
export function buildDownloadsExportCsv(
  rows: ComputedDownloadRow[],
  identifierLabel: string,
): string {
  const records = buildExportRecords(rows, identifierLabel);
  if (records.length === 0) {
    const idCol = identifierLabel.trim() || "Identifier";
    return (
      "\uFEFF" +
      Papa.unparse({
        fields: [
          idCol,
          "Full Name",
          "Email",
          "Status",
          "Certificate Types",
          "Total Downloads",
          "First Downloaded At",
          "Last Downloaded At",
          "Verify Codes",
          "Source",
          "Note",
          "Issues / Name Correction Note",
        ],
        data: [],
      })
    );
  }
  return "\uFEFF" + Papa.unparse(records);
}

/**
 * Generates a native Excel (.xlsx) workbook buffer with readable column widths.
 */
export function buildDownloadsExportXlsx(
  rows: ComputedDownloadRow[],
  identifierLabel: string,
  sheetTitle = "Attendees",
): Uint8Array {
  const records = buildExportRecords(rows, identifierLabel);
  const wb = XLSX.utils.book_new();
  const idCol = identifierLabel.trim() || "Identifier";

  const headers = [
    idCol,
    "Full Name",
    "Email",
    "Status",
    "Certificate Types",
    "Total Downloads",
    "First Downloaded At",
    "Last Downloaded At",
    "Verify Codes",
    "Source",
    "Note",
    "Issues / Name Correction Note",
  ];

  const ws =
    records.length > 0
      ? XLSX.utils.json_to_sheet(records, { header: headers })
      : XLSX.utils.aoa_to_sheet([headers]);

  ws["!cols"] = [
    { wch: 18 },
    { wch: 28 },
    { wch: 28 },
    { wch: 16 },
    { wch: 32 },
    { wch: 15 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 10 },
    { wch: 24 },
    { wch: 34 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, sheetTitle.slice(0, 31) || "Downloads");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Uint8Array(buf);
}
