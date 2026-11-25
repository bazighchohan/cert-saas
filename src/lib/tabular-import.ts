import Papa from "papaparse";
import * as XLSX from "xlsx";
import { validateAttendeeFields } from "@/lib/attendee-validation";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ParsedSheetResult {
  format: "csv" | "xlsx";
  encoding: string;
  delimiter: string;
  headers: string[];
  /** Non-empty data rows with their exact 1-based row number in the uploaded file. */
  rows: Array<{
    rowNumber: number;
    cells: string[];
  }>;
  /** First 10 data rows for quick preview in the mapping step. */
  sampleRows: Array<{
    rowNumber: number;
    cells: string[];
  }>;
  totalDataRows: number;
}

export interface ImportCertTypeOption {
  id: string;
  key: string;
  label: string;
}

export interface ColumnMappingConfig {
  identifierCol: number | null;
  fullNameCol: number | null;
  emailCol: number | null;
  noteCol: number | null;
  /** Optional single column listing one or more certificate type names/keys (comma/pipe separated). */
  certTypesCol: number | null;
  /** Optional boolean columns per certificate type id (truthy cell = assign that type). */
  perTypeCols?: Record<string, number | null>;
  /** Certificate type IDs assigned by default to imported rows (when certTypesCol is unmapped or blank). */
  defaultTypeIds: string[];
}

export interface ImportIssueRow {
  rowNumber: number;
  identifier: string;
  fullName: string;
  email: string;
  category: "invalid" | "duplicate_in_file";
  reason: string;
}

export interface PreparedImportRow {
  rowNumber: number;
  identifier: string;
  fullName: string;
  email: string | null;
  note: string | null;
  typeIds: string[];
  isExistingInEvent: boolean;
}

export interface ModeQuotaEvaluation {
  newAttendees: number;
  updatedAttendees: number;
  skippedAttendees: number;
  newCertificates: number;
  eventCertsAfter: number;
  orgCertsAfter: number;
  eventAttendeesAfter: number;
  withinLimit: boolean;
  limitError: string | null;
}

export interface ImportValidationReport {
  totalRowsInFile: number;
  validCount: number;
  invalidCount: number;
  duplicateInFileCount: number;
  existingInEventCount: number;
  newInEventCount: number;
  issues: ImportIssueRow[];
  preparedRows: PreparedImportRow[];
  previewSampleValid: PreparedImportRow[];
  quotaByMode: {
    skip: ModeQuotaEvaluation;
    update: ModeQuotaEvaluation;
  };
}

function isXlsxMagic(bytes: Uint8Array, fileName = ""): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return true;
  if (bytes.length < 4) return false;
  // ZIP PK\x03\x04 (.xlsx) or OLE2 \xD0\xCF\x11\xE0 (.xls)
  const isZip =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  const isOle =
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0;
  return isZip || isOle;
}

/**
 * Decodes text bytes while detecting UTF-8 BOM, UTF-16LE/BE BOM, strict UTF-8,
 * or Windows-1252 fallback (common for Excel CSV exports containing accents).
 */
export function decodeTextWithEncoding(bytes: Uint8Array): {
  text: string;
  encoding: string;
} {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    const text = new TextDecoder("utf-8").decode(bytes.subarray(3));
    return { text, encoding: "UTF-8 (BOM)" };
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
    return { text, encoding: "UTF-16LE (BOM)" };
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
    return { text, encoding: "UTF-16BE (BOM)" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "UTF-8" };
  } catch {
    const text = new TextDecoder("windows-1252").decode(bytes);
    return { text, encoding: "Windows-1252" };
  }
}

function makeUniqueHeaders(rawHeaderCells: string[], width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const raw = (rawHeaderCells[i] ?? "").replace(/^\uFEFF/, "").trim();
    const base = raw || `Column ${i + 1}`;
    const prev = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), prev + 1);
    out.push(prev === 0 ? base : `${base} (${prev + 1})`);
  }
  return out;
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => !c || !String(c).trim());
}

/**
 * Parses an uploaded CSV/TSV/TXT or .xlsx/.xls file buffer:
 * - Detects encoding (UTF-8, UTF-8 BOM, UTF-16 BOM, Windows-1252) & delimiter (`,`, `;`, `\t`, `|`).
 * - Preserves exact 1-based spreadsheet row numbers even when blank rows appear mid-file.
 * - Enforces the 5,000-row limit.
 */
export function parseUploadedSheetBytes(
  bytes: Uint8Array,
  fileName = "upload.csv",
): ParsedSheetResult {
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("The uploaded file is empty.");
  }

  if (bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error("File exceeds the 10 MB maximum upload size.");
  }

  let rawGrid: string[][];
  let format: "csv" | "xlsx";
  let encoding: string;
  let delimiter: string;

  if (isXlsxMagic(bytes, fileName)) {
    format = "xlsx";
    encoding = "XLSX Workbook";
    delimiter = "worksheet";

    const workbook = XLSX.read(bytes, { type: "array", raw: false });
    const firstSheetName = workbook.SheetNames.find((name) => {
      const ws = workbook.Sheets[name];
      return Boolean(ws && ws["!ref"]);
    });

    if (!firstSheetName) {
      throw new Error("The uploaded Excel workbook contains no data sheets.");
    }

    const sheet = workbook.Sheets[firstSheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: true,
    });

    rawGrid = aoa.map((row) =>
      Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : [],
    );
  } else {
    format = "csv";
    const decoded = decodeTextWithEncoding(bytes);
    encoding = decoded.encoding;

    const parsed = Papa.parse<string[]>(decoded.text, {
      header: false,
      skipEmptyLines: false,
      delimitersToGuess: [",", ";", "\t", "|"],
    });

    const metaDelim = parsed.meta.delimiter || ",";
    delimiter =
      metaDelim === "\t"
        ? "Tab (\\t)"
        : metaDelim === ";"
          ? "Semicolon (;)"
          : metaDelim === "|"
            ? "Pipe (|)"
            : "Comma (,)";

    rawGrid = (parsed.data ?? []).map((row) =>
      Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : [],
    );
  }

  // Locate the first non-blank row as the header row
  let headerRowIdx = -1;
  for (let i = 0; i < rawGrid.length; i++) {
    if (!isBlankRow(rawGrid[i])) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error("No header or data rows were found in the uploaded file.");
  }

  let maxCols = rawGrid[headerRowIdx].length;
  const dataRows: Array<{ rowNumber: number; cells: string[] }> = [];

  for (let i = headerRowIdx + 1; i < rawGrid.length; i++) {
    const rowCells = rawGrid[i];
    if (isBlankRow(rowCells)) continue;
    if (rowCells.length > maxCols) maxCols = rowCells.length;
    dataRows.push({
      rowNumber: i + 1, // exact 1-based row number in the user's file
      cells: rowCells,
    });
  }

  if (dataRows.length === 0) {
    throw new Error(
      "The uploaded file has a header row but contains 0 data rows.",
    );
  }

  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `File contains ${dataRows.length.toLocaleString()} rows, which exceeds the maximum of ${MAX_IMPORT_ROWS.toLocaleString()} rows per import.`,
    );
  }

  const headers = makeUniqueHeaders(rawGrid[headerRowIdx], maxCols);
  const normalizedRows = dataRows.map((r) => ({
    rowNumber: r.rowNumber,
    cells: Array.from({ length: maxCols }, (_, colIdx) => r.cells[colIdx] ?? ""),
  }));

  return {
    format,
    encoding,
    delimiter,
    headers,
    rows: normalizedRows,
    sampleRows: normalizedRows.slice(0, 10),
    totalDataRows: normalizedRows.length,
  };
}

function normHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Auto-detects column mappings by header names, custom identifierLabel, and
 * available certificate types.
 */
export function autoDetectColumnMapping(
  headers: string[],
  identifierLabel: string,
  certTypes: ImportCertTypeOption[],
): ColumnMappingConfig {
  const normed = headers.map(normHeader);
  const usedCols = new Set<number>();

  const customIdNorm = normHeader(identifierLabel);
  const idPatterns = new Set([
    customIdNorm,
    "identifier",
    "id",
    "roll_no",
    "rollno",
    "roll_number",
    "roll",
    "reg_no",
    "reg_id",
    "registration_no",
    "registration_number",
    "registration_id",
    "member_id",
    "student_id",
    "employee_id",
    "emp_id",
    "cnic",
    "badge_id",
  ]);

  const namePatterns = new Set([
    "full_name",
    "fullname",
    "name",
    "student_name",
    "recipient",
    "recipient_name",
    "participant",
    "participant_name",
    "attendee",
    "attendee_name",
    "member_name",
  ]);

  const emailPatterns = new Set([
    "email",
    "e_mail",
    "email_address",
    "mail",
    "user_email",
    "student_email",
  ]);

  const notePatterns = new Set([
    "note",
    "notes",
    "remark",
    "remarks",
    "comment",
    "comments",
    "department",
    "designation",
  ]);

  const certColPatterns = new Set([
    "certificate_types",
    "certificate_type",
    "cert_types",
    "cert_type",
    "certificates",
    "certificate",
    "type",
    "types",
    "award",
    "category",
  ]);

  const findCol = (exactSet: Set<string>, substringRegex?: RegExp): number | null => {
    for (let i = 0; i < normed.length; i++) {
      if (!usedCols.has(i) && exactSet.has(normed[i])) {
        usedCols.add(i);
        return i;
      }
    }
    if (substringRegex) {
      for (let i = 0; i < normed.length; i++) {
        if (!usedCols.has(i) && substringRegex.test(normed[i])) {
          usedCols.add(i);
          return i;
        }
      }
    }
    return null;
  };

  const identifierCol = findCol(
    idPatterns,
    /(roll|reg|member_?id|student_?id|emp_?id|identifier|badge|cnic|serial)/,
  );
  const fullNameCol = findCol(namePatterns, /(full_?name|name|recipient|participant)/);
  const emailCol = findCol(emailPatterns, /mail/);
  const noteCol = findCol(notePatterns, /(note|remark|comment)/);
  const certTypesCol = findCol(certColPatterns);

  const perTypeCols: Record<string, number | null> = {};
  for (const ct of certTypes) {
    const ctKeyNorm = normHeader(ct.key);
    const ctLabelNorm = normHeader(ct.label);
    let matched: number | null = null;
    for (let i = 0; i < normed.length; i++) {
      if (usedCols.has(i)) continue;
      if (
        normed[i] === ctKeyNorm ||
        normed[i] === ctLabelNorm ||
        (ctKeyNorm === "appreciation" &&
          (normed[i] === "is_society_member" || normed[i] === "society_member"))
      ) {
        matched = i;
        usedCols.add(i);
        break;
      }
    }
    perTypeCols[ct.id] = matched;
  }

  const hasAnyPerTypeCol = Object.values(perTypeCols).some((v) => v !== null);
  const defaultTypeIds =
    certTypesCol !== null && !hasAnyPerTypeCol
      ? certTypes[0]
        ? [certTypes[0].id]
        : []
      : certTypes[0]
        ? [certTypes[0].id]
        : [];

  return {
    identifierCol,
    fullNameCol,
    emailCol,
    noteCol,
    certTypesCol,
    perTypeCols,
    defaultTypeIds,
  };
}

function isTruthyCell(val: string): boolean {
  const v = val.trim().toLowerCase();
  return (
    v === "1" ||
    v === "true" ||
    v === "yes" ||
    v === "y" ||
    v === "x" ||
    v === "✓" ||
    v === "checked"
  );
}

export interface ExistingAttendeeSnapshot {
  id: string;
  identifier: string;
  certificateTypeIds: Set<string>;
}

/**
 * Validates all rows using the user-selected column mapping, detects invalid rows,
 * duplicates in file, existing vs new rows in the event, and evaluates plan quotas
 * for both "skip" and "update" modes before anything is inserted.
 */
export function validateMappedImportRows(params: {
  rows: Array<{ rowNumber: number; cells: string[] }>;
  mapping: ColumnMappingConfig;
  identifierLabel: string;
  uppercaseIdentifiers: boolean;
  certTypes: ImportCertTypeOption[];
  existingByLowerId: Map<string, ExistingAttendeeSnapshot>;
  quotaContext: {
    planName: string;
    eventAttendeesCurrent: number;
    eventCertsCurrent: number;
    maxCertificatesPerEvent: number | null;
    orgCertsCurrent: number;
    maxCertificatesTotal: number | null;
  };
}): ImportValidationReport {
  const {
    rows,
    mapping,
    identifierLabel,
    uppercaseIdentifiers,
    certTypes,
    existingByLowerId,
    quotaContext,
  } = params;

  if (mapping.identifierCol === null || mapping.fullNameCol === null) {
    throw new Error(
      `Please map both "${identifierLabel}" and "Full Name" columns before continuing.`,
    );
  }

  const certLookup = new Map<string, string>(); // normalized key/label -> certType.id
  const validTypeIdsSet = new Set<string>();
  for (const ct of certTypes) {
    validTypeIdsSet.add(ct.id);
    certLookup.set(ct.key.toLowerCase().trim(), ct.id);
    certLookup.set(ct.label.toLowerCase().trim(), ct.id);
    certLookup.set(normHeader(ct.key), ct.id);
    certLookup.set(normHeader(ct.label), ct.id);
  }

  const cleanDefaultTypes = (mapping.defaultTypeIds ?? []).filter((id) =>
    validTypeIdsSet.has(id),
  );

  const issues: ImportIssueRow[] = [];
  const preparedRows: PreparedImportRow[] = [];
  const seenInFile = new Map<string, number>(); // lower(identifier) -> first rowNumber

  let invalidCount = 0;
  let duplicateInFileCount = 0;
  let existingInEventCount = 0;
  let newInEventCount = 0;

  for (const r of rows) {
    const rawIdentifier = r.cells[mapping.identifierCol] ?? "";
    const rawFullName = r.cells[mapping.fullNameCol] ?? "";
    const rawEmail =
      mapping.emailCol !== null ? (r.cells[mapping.emailCol] ?? "") : "";
    const rawNote =
      mapping.noteCol !== null ? (r.cells[mapping.noteCol] ?? "") : "";

    const fieldCheck = validateAttendeeFields({
      identifier: rawIdentifier,
      fullName: rawFullName,
      email: rawEmail,
      note: rawNote,
      uppercaseIdentifiers,
      identifierLabel,
    });

    if (fieldCheck.error || !fieldCheck.clean) {
      invalidCount++;
      issues.push({
        rowNumber: r.rowNumber,
        identifier: rawIdentifier,
        fullName: rawFullName,
        email: rawEmail,
        category: "invalid",
        reason: fieldCheck.error || "Invalid row values.",
      });
      continue;
    }

    // Resolve certificate types for this row
    const rowTypeIds = new Set<string>();

    if (mapping.certTypesCol !== null) {
      const rawTypesCell = (r.cells[mapping.certTypesCol] ?? "").trim();
      if (rawTypesCell) {
        const tokens = rawTypesCell
          .split(/[,;|+/]+/)
          .map((t) => t.trim())
          .filter(Boolean);

        let unknownToken: string | null = null;
        for (const tok of tokens) {
          const found =
            certLookup.get(tok.toLowerCase()) ?? certLookup.get(normHeader(tok));
          if (!found) {
            unknownToken = tok;
            break;
          }
          rowTypeIds.add(found);
        }

        if (unknownToken) {
          invalidCount++;
          const allowedNames = certTypes.map((c) => c.label).join(", ") || "none";
          issues.push({
            rowNumber: r.rowNumber,
            identifier: fieldCheck.clean.identifier,
            fullName: fieldCheck.clean.fullName,
            email: fieldCheck.clean.email ?? "",
            category: "invalid",
            reason: `Unknown certificate type "${unknownToken}" (available: ${allowedNames}).`,
          });
          continue;
        }
      } else {
        for (const dt of cleanDefaultTypes) rowTypeIds.add(dt);
      }
    } else {
      for (const dt of cleanDefaultTypes) rowTypeIds.add(dt);
    }

    // Check optional per-type boolean columns
    if (mapping.perTypeCols) {
      for (const [ctId, colIdx] of Object.entries(mapping.perTypeCols)) {
        if (
          colIdx !== null &&
          colIdx !== undefined &&
          validTypeIdsSet.has(ctId) &&
          isTruthyCell(r.cells[colIdx] ?? "")
        ) {
          rowTypeIds.add(ctId);
        }
      }
    }

    const lowerId = fieldCheck.clean.identifier.toLowerCase();
    const firstSeenRow = seenInFile.get(lowerId);
    if (firstSeenRow !== undefined) {
      duplicateInFileCount++;
      issues.push({
        rowNumber: r.rowNumber,
        identifier: fieldCheck.clean.identifier,
        fullName: fieldCheck.clean.fullName,
        email: fieldCheck.clean.email ?? "",
        category: "duplicate_in_file",
        reason: `Duplicate ${identifierLabel} "${fieldCheck.clean.identifier}" in file (first appeared on row ${firstSeenRow}).`,
      });
      continue;
    }

    seenInFile.set(lowerId, r.rowNumber);

    const existingSnap = existingByLowerId.get(lowerId);
    const isExisting = Boolean(existingSnap);
    if (isExisting) {
      existingInEventCount++;
    } else {
      newInEventCount++;
    }

    preparedRows.push({
      rowNumber: r.rowNumber,
      identifier: fieldCheck.clean.identifier,
      fullName: fieldCheck.clean.fullName,
      email: fieldCheck.clean.email,
      note: fieldCheck.clean.note,
      typeIds: Array.from(rowTypeIds),
      isExistingInEvent: isExisting,
    });
  }

  // Evaluate exact certificate & attendee additions for both "skip" and "update" modes
  const evaluateMode = (mode: "skip" | "update"): ModeQuotaEvaluation => {
    let newAttendees = 0;
    let updatedAttendees = 0;
    let skippedAttendees = 0;
    let newCertificates = 0;

    for (const row of preparedRows) {
      const existingSnap = existingByLowerId.get(row.identifier.toLowerCase());
      if (!existingSnap) {
        newAttendees++;
        newCertificates += row.typeIds.length;
      } else if (mode === "skip") {
        skippedAttendees++;
      } else {
        updatedAttendees++;
        for (const tid of row.typeIds) {
          if (!existingSnap.certificateTypeIds.has(tid)) {
            newCertificates++;
          }
        }
      }
    }

    const eventCertsAfter = quotaContext.eventCertsCurrent + newCertificates;
    const orgCertsAfter = quotaContext.orgCertsCurrent + newCertificates;
    const eventAttendeesAfter = quotaContext.eventAttendeesCurrent + newAttendees;

    const reasons: string[] = [];
    if (
      quotaContext.maxCertificatesPerEvent !== null &&
      eventCertsAfter > quotaContext.maxCertificatesPerEvent
    ) {
      const overBy = eventCertsAfter - quotaContext.maxCertificatesPerEvent;
      reasons.push(
        `Importing would issue ${newCertificates} new certificate(s), bringing this event to ${eventCertsAfter}/${quotaContext.maxCertificatesPerEvent} certificates on the ${quotaContext.planName} plan (exceeds limit by ${overBy}).`,
      );
    } else if (
      quotaContext.maxCertificatesPerEvent !== null &&
      eventAttendeesAfter > quotaContext.maxCertificatesPerEvent
    ) {
      const overBy = eventAttendeesAfter - quotaContext.maxCertificatesPerEvent;
      reasons.push(
        `Importing would add ${newAttendees} new attendee(s), bringing this event to ${eventAttendeesAfter}/${quotaContext.maxCertificatesPerEvent} attendees allowed on the ${quotaContext.planName} plan (exceeds limit by ${overBy}).`,
      );
    }

    if (
      quotaContext.maxCertificatesTotal !== null &&
      orgCertsAfter > quotaContext.maxCertificatesTotal
    ) {
      const overBy = orgCertsAfter - quotaContext.maxCertificatesTotal;
      reasons.push(
        `Importing would bring your organization to ${orgCertsAfter}/${quotaContext.maxCertificatesTotal} total certificates across all events on the ${quotaContext.planName} plan (exceeds total limit by ${overBy}).`,
      );
    }

    return {
      newAttendees,
      updatedAttendees,
      skippedAttendees,
      newCertificates,
      eventCertsAfter,
      orgCertsAfter,
      eventAttendeesAfter,
      withinLimit: reasons.length === 0,
      limitError: reasons.length > 0 ? reasons.join(" ") : null,
    };
  };

  return {
    totalRowsInFile: rows.length,
    validCount: preparedRows.length,
    invalidCount,
    duplicateInFileCount,
    existingInEventCount,
    newInEventCount,
    issues,
    preparedRows,
    previewSampleValid: preparedRows.slice(0, 10),
    quotaByMode: {
      skip: evaluateMode("skip"),
      update: evaluateMode("update"),
    },
  };
}

/**
 * Generates a downloadable CSV listing all invalid & duplicate-in-file rows with
 * exact row numbers and human-readable reasons.
 */
export function buildErrorReportCsv(issues: ImportIssueRow[]): string {
  return Papa.unparse(
    issues.map((i) => ({
      row_number: i.rowNumber,
      category: i.category,
      identifier: i.identifier,
      full_name: i.fullName,
      email: i.email,
      reason: i.reason,
    })),
  );
}

/**
 * Generates a sample CSV tailored to the event's identifierLabel and certificate types.
 */
export function buildSampleImportCsv(
  identifierLabel: string,
  certTypes: ImportCertTypeOption[],
): string {
  const idHeader = identifierLabel.trim() || "Identifier";
  const firstType = certTypes[0]?.label || "Certificate of Participation";
  const secondType = certTypes[1]?.label || firstType;

  return Papa.unparse([
    {
      [idHeader]: "FA24-BSE-001",
      "Full Name": "Areeba Khan",
      Email: "areeba.khan@example.edu",
      "Certificate Types": firstType,
      Note: "Regular attendee",
    },
    {
      [idHeader]: "FA24-BSE-002",
      "Full Name": "Muhammad Abdul Rehman",
      Email: "rehman@example.edu",
      "Certificate Types":
        secondType !== firstType ? `${firstType}, ${secondType}` : firstType,
      Note: "Volunteer / Organizer",
    },
  ]);
}
