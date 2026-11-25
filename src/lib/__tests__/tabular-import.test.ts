import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as XLSX from "xlsx";
import {
  autoDetectColumnMapping,
  buildErrorReportCsv,
  buildSampleImportCsv,
  parseUploadedSheetBytes,
  validateMappedImportRows,
  type ExistingAttendeeSnapshot,
} from "@/lib/tabular-import";

const CERT_TYPES = [
  { id: "ct-part", key: "participation", label: "Certificate of Participation" },
  { id: "ct-appr", key: "appreciation", label: "Certificate of Appreciation" },
];

describe("tabular-import (messy 1,000-row CSV, BOM/delimiter, XLSX, quotas)", () => {
  it("parses a messy 1,000-row UTF-8 BOM semicolon CSV, preserves exact row numbers across blank lines, and reports errors by row", () => {
    const lines: string[] = [];
    // Line 1: header with messy arbitrary column names
    lines.push("Notes;Student Reg #;Participant Name;E-Mail Address;Award");
    // Line 2: blank line right after header!
    lines.push(";;;");

    // Generate 1,000 data rows (lines 3 .. 1004, with another blank line after 500)
    let expectedInvalid = 0;
    let expectedDupInFile = 0;

    for (let i = 1; i <= 1000; i++) {
      if (i === 501) {
        lines.push(""); // mid-file blank line to test exact row-number preservation
      }

      if (i === 5) {
        // Missing full name -> should be reported at exact file row 7 (line index + 1)
        lines.push(`VIP;fa24-bse-0005;;user5@uni.edu;Participation`);
        expectedInvalid++;
      } else if (i === 12) {
        // Bad email -> exact file row 14
        lines.push(`Late;fa24-bse-0012;Ali Raza;not-an-email;Participation`);
        expectedInvalid++;
      } else if (i === 25) {
        // Unknown certificate type -> exact file row 27
        lines.push(`Speaker;fa24-bse-0025;Sara Ahmed;sara@uni.edu;Platinum Medal`);
        expectedInvalid++;
      } else if (i === 600) {
        // Duplicate of i=1 (after the second blank line -> exact file row 603!)
        lines.push(`Dup;  FA24-BSE-0001 ;Duplicate Person;dup@uni.edu;Participation`);
        expectedDupInFile++;
      } else {
        const award =
          i % 10 === 0
            ? "Certificate of Participation | Appreciation"
            : "Participation";
        lines.push(
          `Batch ${Math.ceil(i / 250)};  fa24-bse-${String(i).padStart(4, "0")}  ;  Attendee   Number ${i} ;user${i}@uni.edu;${award}`,
        );
      }
    }

    // Prepend UTF-8 BOM (EF BB BF)
    const csvWithBom = "\uFEFF" + lines.join("\r\n");
    const bytes = new TextEncoder().encode(csvWithBom);

    const parsed = parseUploadedSheetBytes(bytes, "messy-1000.csv");
    assert.equal(parsed.format, "csv");
    assert.equal(parsed.encoding, "UTF-8 (BOM)");
    assert.equal(parsed.delimiter, "Semicolon (;)");
    assert.equal(parsed.totalDataRows, 1000);
    assert.equal(parsed.sampleRows.length, 10);
    // First data row is on line 3 because line 1 is header and line 2 is blank!
    assert.equal(parsed.sampleRows[0].rowNumber, 3);

    // Auto-detect mapping
    const mapping = autoDetectColumnMapping(
      parsed.headers,
      "Registration number",
      CERT_TYPES,
    );
    assert.equal(mapping.noteCol, 0);
    assert.equal(mapping.identifierCol, 1);
    assert.equal(mapping.fullNameCol, 2);
    assert.equal(mapping.emailCol, 3);
    assert.equal(mapping.certTypesCol, 4);

    // Simulate 2 attendees already existing in the event
    const existing = new Map<string, ExistingAttendeeSnapshot>([
      [
        "fa24-bse-0001",
        {
          id: "existing-1",
          identifier: "FA24-BSE-0001",
          certificateTypeIds: new Set(["ct-part"]),
        },
      ],
      [
        "fa24-bse-0002",
        {
          id: "existing-2",
          identifier: "FA24-BSE-0002",
          certificateTypeIds: new Set(["ct-part"]),
        },
      ],
    ]);

    const report = validateMappedImportRows({
      rows: parsed.rows,
      mapping,
      identifierLabel: "Registration number",
      uppercaseIdentifiers: true,
      certTypes: CERT_TYPES,
      existingByLowerId: existing,
      quotaContext: {
        planName: "Enterprise",
        eventAttendeesCurrent: 2,
        eventCertsCurrent: 2,
        maxCertificatesPerEvent: 5000,
        orgCertsCurrent: 2,
        maxCertificatesTotal: 10000,
      },
    });

    assert.equal(report.totalRowsInFile, 1000);
    assert.equal(report.invalidCount, expectedInvalid); // 3
    assert.equal(report.duplicateInFileCount, expectedDupInFile); // 1
    assert.equal(report.validCount, 996);
    assert.equal(report.existingInEventCount, 2);
    assert.equal(report.newInEventCount, 994);
    assert.equal(report.quotaByMode.skip.withinLimit, true);
    assert.equal(report.quotaByMode.update.withinLimit, true);

    // Verify exact row numbers on issues!
    assert.equal(report.issues.length, 4);
    assert.equal(report.issues[0].rowNumber, 7); // i = 5 (+ header line 1 + blank line 2)
    assert.match(report.issues[0].reason, /Full name is required/i);
    assert.equal(report.issues[1].rowNumber, 14); // i = 12
    assert.match(report.issues[1].reason, /valid email/i);
    assert.equal(report.issues[2].rowNumber, 27); // i = 25
    assert.match(report.issues[2].reason, /Unknown certificate type "Platinum Medal"/i);
    assert.equal(report.issues[3].rowNumber, 603); // i = 600 (+ second blank line at 501!)
    assert.equal(report.issues[3].category, "duplicate_in_file");
    assert.match(report.issues[3].reason, /first appeared on row 3/i);

    // Error CSV contains all 4 issue rows
    const errCsv = buildErrorReportCsv(report.issues);
    assert.ok(errCsv.includes("603"));
    assert.ok(errCsv.includes("Platinum Medal"));
  });

  it("parses .xlsx Excel workbooks server-side via SheetJS and generates sample CSVs", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Roll Number", "Full Name", "Email"],
      ["24K-1001", "Zainab Tariq", "zainab@nu.edu.pk"],
      ["24K-1002", "Hamza Siddiqui", "hamza@nu.edu.pk"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Attendees");
    const xlsxBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const parsed = parseUploadedSheetBytes(
      new Uint8Array(xlsxBuf),
      "attendees.xlsx",
    );
    assert.equal(parsed.format, "xlsx");
    assert.equal(parsed.encoding, "XLSX Workbook");
    assert.equal(parsed.totalDataRows, 2);
    assert.deepEqual(parsed.headers, ["Roll Number", "Full Name", "Email"]);

    const sampleCsv = buildSampleImportCsv("Roll Number", CERT_TYPES);
    assert.ok(sampleCsv.includes("Roll Number"));
    assert.ok(sampleCsv.includes("Certificate of Participation"));
  });

  it("blocks and clearly reports imports that would exceed plan limits before inserting", () => {
    const rows = Array.from({ length: 15 }, (_, idx) => ({
      rowNumber: idx + 2,
      cells: [`ID-${idx + 1}`, `Person ${idx + 1}`],
    }));

    const report = validateMappedImportRows({
      rows,
      mapping: {
        identifierCol: 0,
        fullNameCol: 1,
        emailCol: null,
        noteCol: null,
        certTypesCol: null,
        defaultTypeIds: ["ct-part"],
      },
      identifierLabel: "Member ID",
      uppercaseIdentifiers: true,
      certTypes: CERT_TYPES,
      existingByLowerId: new Map(),
      quotaContext: {
        planName: "Free",
        eventAttendeesCurrent: 40,
        eventCertsCurrent: 40,
        maxCertificatesPerEvent: 50,
        orgCertsCurrent: 40,
        maxCertificatesTotal: 50,
      },
    });

    assert.equal(report.quotaByMode.skip.withinLimit, false);
    assert.match(
      report.quotaByMode.skip.limitError ?? "",
      /55\/50 certificates on the Free plan \(exceeds limit by 5\)/,
    );
  });
});
