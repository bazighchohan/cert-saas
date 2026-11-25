import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  buildDailyDownloadsSeries,
  buildDownloadsExportCsv,
  buildDownloadsExportXlsx,
  computeDownloadsAnalytics,
  type RawAttendeeForAnalytics,
  type RawDownloadLogEntry,
} from "../downloads-analytics";

const CERT_PARTICIPATION = "11111111-1111-1111-1111-111111111111";
const CERT_WINNER = "22222222-2222-2222-2222-222222222222";

function sampleDataset(): {
  attendees: RawAttendeeForAnalytics[];
  logs: RawDownloadLogEntry[];
} {
  const attendees: RawAttendeeForAnalytics[] = [
    {
      id: "att-1",
      identifier: "CS-101",
      fullName: "Ayesha Khan",
      email: "ayesha@example.edu",
      source: "csv",
      note: "Dean's list",
      issueNote: "Corrected spelling from 'Aisha' to 'Ayesha' per student email",
      createdAt: "2026-11-20T09:00:00Z",
      certificates: [
        {
          id: "ac-1",
          certificateTypeId: CERT_PARTICIPATION,
          certificateTypeLabel: "Participation",
          downloadCount: 2,
          verifyCode: "VER-101P",
          firstDownloadedAt: "2026-11-22T10:15:00Z",
          lastDownloadedAt: "2026-11-24T14:30:00Z",
        },
        {
          id: "ac-2",
          certificateTypeId: CERT_WINNER,
          certificateTypeLabel: "Winner",
          downloadCount: 0,
          verifyCode: "VER-101W",
          firstDownloadedAt: null,
          lastDownloadedAt: null,
        },
      ],
    },
    {
      id: "att-2",
      identifier: "CS-102",
      fullName: "Bilal Ahmed",
      email: "Bilal@Example.edu ",
      source: "csv",
      note: null,
      issueNote: null,
      createdAt: "2026-11-20T09:01:00Z",
      certificates: [
        {
          id: "ac-3",
          certificateTypeId: CERT_PARTICIPATION,
          certificateTypeLabel: "Participation",
          downloadCount: 0,
          verifyCode: "VER-102P",
          firstDownloadedAt: null,
          lastDownloadedAt: null,
        },
      ],
    },
    {
      id: "att-3",
      identifier: "CS-103",
      fullName: "فاطمہ زہرا (Fatima Zahra)",
      email: "fatima@example.edu",
      source: "manual",
      note: "Speaker",
      issueNote: "Added Urdu script alongside Latin name",
      createdAt: "2026-11-20T09:02:00Z",
      certificates: [
        {
          id: "ac-4",
          certificateTypeId: CERT_WINNER,
          certificateTypeLabel: "Winner",
          downloadCount: 1,
          verifyCode: "VER-103W",
          firstDownloadedAt: "2026-11-24T16:00:00Z",
          lastDownloadedAt: "2026-11-24T16:00:00Z",
        },
      ],
    },
    {
      id: "att-4",
      identifier: "CS-104",
      fullName: "Daniyal Raza",
      email: null,
      source: "csv",
      note: null,
      issueNote: null,
      createdAt: "2026-11-20T09:03:00Z",
      certificates: [
        {
          id: "ac-5",
          certificateTypeId: CERT_PARTICIPATION,
          certificateTypeLabel: "Participation",
          downloadCount: 0,
          verifyCode: "VER-104P",
          firstDownloadedAt: null,
          lastDownloadedAt: null,
        },
      ],
    },
    {
      id: "att-5",
      identifier: "CS-105",
      fullName: "Bilal Duplicate Email",
      email: "bilal@example.edu", // duplicate email (case-insensitive) to verify deduplication
      source: "manual",
      note: null,
      issueNote: null,
      createdAt: "2026-11-20T09:04:00Z",
      certificates: [
        {
          id: "ac-6",
          certificateTypeId: CERT_PARTICIPATION,
          certificateTypeLabel: "Participation",
          downloadCount: 0,
          verifyCode: "VER-105P",
          firstDownloadedAt: null,
          lastDownloadedAt: null,
        },
      ],
    },
  ];

  const logs: RawDownloadLogEntry[] = [
    {
      id: 1,
      attendeeCertificateId: "ac-1",
      certificateTypeId: CERT_PARTICIPATION,
      downloadedAt: "2026-11-22T10:15:00Z",
      ipHash: "abcdef1234567890",
    },
    {
      id: 2,
      attendeeCertificateId: "ac-1",
      certificateTypeId: CERT_PARTICIPATION,
      downloadedAt: "2026-11-24T14:30:00Z",
      ipHash: "abcdef1234567890",
    },
    {
      id: 3,
      attendeeCertificateId: "ac-4",
      certificateTypeId: CERT_WINNER,
      downloadedAt: "2026-11-24T16:00:00Z",
      ipHash: "9988776655443322",
    },
  ];

  return { attendees, logs };
}

describe("computeDownloadsAnalytics", () => {
  it("computes exact KPI totals, completion percentage, and deduplicated pending emails", () => {
    const { attendees, logs } = sampleDataset();

    const res = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "all",
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });

    assert.equal(res.totalAttendees, 5);
    assert.equal(res.downloadedCount, 2); // att-1 and att-3
    assert.equal(res.notDownloadedCount, 3); // att-2, att-4, att-5
    assert.equal(
      res.totalAttendees,
      res.downloadedCount + res.notDownloadedCount,
    );
    assert.equal(res.completionPct, 40);
    assert.equal(res.totalLogDownloads, 3);

    // Only non-downloaded attendees with emails, normalized & deduplicated:
    // att-1 & att-3 downloaded -> excluded; att-4 has null email; att-2 & att-5 share bilal@example.edu
    assert.deepEqual(res.pendingEmails, ["bilal@example.edu"]);
    assert.equal(res.filteredRows.length, 5);
  });

  it("filters accurately by status (downloaded / not_downloaded), certificate type, and issue note search", () => {
    const { attendees, logs } = sampleDataset();

    const downloadedOnly = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "downloaded",
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });
    assert.deepEqual(
      downloadedOnly.filteredRows.map((r) => r.id),
      ["att-3", "att-1"], // sorted by most recent lastDownloadedAt descending
    );

    const notDownloadedOnly = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "not_downloaded",
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });
    assert.deepEqual(
      notDownloadedOnly.filteredRows.map((r) => r.id),
      ["att-2", "att-4", "att-5"],
    );

    // Scoped to CERT_WINNER: att-1 (0 winner downloads, has email!) and att-3 (1 winner download)
    const winnerScoped = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "all",
      certTypeIdFilter: CERT_WINNER,
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });
    assert.equal(winnerScoped.totalAttendees, 2);
    assert.equal(winnerScoped.downloadedCount, 1);
    assert.equal(winnerScoped.notDownloadedCount, 1);
    assert.equal(winnerScoped.completionPct, 50);
    assert.equal(winnerScoped.totalLogDownloads, 1);
    assert.deepEqual(winnerScoped.pendingEmails, ["ayesha@example.edu"]);

    // Search matches issueNote text
    const issueSearch = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "all",
      search: "Urdu script",
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });
    assert.deepEqual(
      issueSearch.filteredRows.map((r) => r.id),
      ["att-3"],
    );
  });

  it("aggregates daily download_log series accurately across a 14-day window", () => {
    const { logs } = sampleDataset();
    const series = buildDailyDownloadsSeries(logs, "2026-11-25T00:00:00Z");

    assert.equal(series.length, 14);
    assert.equal(series[0]?.date, "2026-11-12");
    assert.equal(series[series.length - 1]?.date, "2026-11-25");

    const byDate = new Map(series.map((p) => [p.date, p.downloads]));
    assert.equal(byDate.get("2026-11-22"), 1);
    assert.equal(byDate.get("2026-11-24"), 2);
    assert.equal(byDate.get("2026-11-23"), 0);

    const totalFromChart = series.reduce((sum, p) => sum + p.downloads, 0);
    assert.equal(totalFromChart, logs.length);
  });
});

describe("CSV and Excel (.xlsx) exports", () => {
  it("exports UTF-8 BOM CSV and native .xlsx that round-trip cleanly with non-Latin characters and issue notes", () => {
    const { attendees, logs } = sampleDataset();

    const downloaded = computeDownloadsAnalytics({
      attendees,
      downloadLogs: logs,
      statusFilter: "downloaded",
      referenceTodayIso: "2026-11-25T12:00:00Z",
    });

    // 1. CSV export verification
    const csv = buildDownloadsExportCsv(downloaded.filteredRows, "Roll Number");
    assert.ok(csv.startsWith("\uFEFF"), "CSV must start with UTF-8 BOM for Excel");

    const parsedCsv = Papa.parse<Record<string, string>>(csv.slice(1), {
      header: true,
      skipEmptyLines: true,
    });
    assert.equal(parsedCsv.errors.length, 0);
    assert.equal(parsedCsv.data.length, 2);
    assert.equal(parsedCsv.data[0]?.["Roll Number"], "CS-103");
    assert.equal(
      parsedCsv.data[0]?.["Full Name"],
      "فاطمہ زہرا (Fatima Zahra)",
    );
    assert.equal(
      parsedCsv.data[0]?.["Issues / Name Correction Note"],
      "Added Urdu script alongside Latin name",
    );
    assert.equal(
      parsedCsv.data[1]?.["Issues / Name Correction Note"],
      "Corrected spelling from 'Aisha' to 'Ayesha' per student email",
    );

    // 2. Excel (.xlsx) export verification
    const xlsxBytes = buildDownloadsExportXlsx(
      downloaded.filteredRows,
      "Roll Number",
      "Downloaded",
    );
    assert.ok(xlsxBytes.byteLength > 100);
    // ZIP magic bytes PK\x03\x04
    assert.equal(xlsxBytes[0], 0x50);
    assert.equal(xlsxBytes[1], 0x4b);

    const wb = XLSX.read(xlsxBytes, { type: "array" });
    assert.deepEqual(wb.SheetNames, ["Downloaded"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets["Downloaded"]!,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.["Roll Number"], "CS-103");
    assert.equal(rows[0]?.["Full Name"], "فاطمہ زہرا (Fatima Zahra)");
    assert.equal(rows[0]?.["Total Downloads"], 1);
    assert.equal(rows[1]?.["Roll Number"], "CS-101");
    assert.equal(rows[1]?.["Total Downloads"], 2);
    assert.equal(
      rows[1]?.["Issues / Name Correction Note"],
      "Corrected spelling from 'Aisha' to 'Ayesha' per student email",
    );

    // 3. Empty list export still produces valid headers in both CSV and XLSX
    const emptyCsv = buildDownloadsExportCsv([], "Member ID");
    assert.ok(emptyCsv.startsWith("\uFEFFMember ID,Full Name,Email,Status"));
    const emptyXlsx = buildDownloadsExportXlsx([], "Member ID", "Not Downloaded");
    const emptyWb = XLSX.read(emptyXlsx, { type: "array" });
    const emptyAoA = XLSX.utils.sheet_to_json<string[]>(
      emptyWb.Sheets["Not Downloaded"]!,
      { header: 1 },
    );
    assert.equal(emptyAoA[0]?.[0], "Member ID");
    assert.equal(
      emptyAoA[0]?.[emptyAoA[0].length - 1],
      "Issues / Name Correction Note",
    );
  });
});
