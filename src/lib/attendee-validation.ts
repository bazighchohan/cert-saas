/**
 * Shared client + server validation and normalization for event attendees.
 */

export function normalizeAttendeeIdentifier(
  raw: string,
  uppercaseIdentifiers = true,
): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return "";
  return uppercaseIdentifiers ? collapsed.toUpperCase() : collapsed;
}

export interface ValidatedAttendeeFields {
  identifier: string;
  fullName: string;
  email: string | null;
  note: string | null;
}

export function validateAttendeeFields(input: {
  identifier: string;
  fullName: string;
  email?: string | null;
  note?: string | null;
  uppercaseIdentifiers?: boolean;
  identifierLabel?: string;
}): { error?: string; clean?: ValidatedAttendeeFields } {
  const label = input.identifierLabel?.trim() || "Identifier";
  const identifier = normalizeAttendeeIdentifier(
    input.identifier ?? "",
    input.uppercaseIdentifiers ?? true,
  );

  if (identifier.length < 1 || identifier.length > 100) {
    return {
      error: `${label} is required and must be at most 100 characters.`,
    };
  }

  const fullName = (input.fullName ?? "").trim().replace(/\s+/g, " ");
  if (fullName.length < 1 || fullName.length > 200) {
    return {
      error: "Full name is required and must be at most 200 characters.",
    };
  }

  const rawEmail = (input.email ?? "").trim().toLowerCase();
  const email = rawEmail ? rawEmail : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return {
      error: "Please enter a valid email address (or leave it blank).",
    };
  }

  const rawNote = (input.note ?? "").trim();
  const note = rawNote ? rawNote : null;
  if (note && note.length > 1000) {
    return {
      error: "Note cannot exceed 1,000 characters.",
    };
  }

  return {
    clean: {
      identifier,
      fullName,
      email,
      note,
    },
  };
}
