/**
 * Shared client + server validation for event slugs and fields.
 */

export const RESERVED_EVENT_SLUGS = new Set([
  "admin",
  "api",
  "dashboard",
  "login",
  "signup",
  "e",
  "auth",
  "forgot-password",
  "reset-password",
  "settings",
  "billing",
  "help",
  "events",
  "public",
  "samples",
  "fonts",
  "verify",
  "pricing",
  "about",
  "contact",
  "support",
  "terms",
  "privacy",
  "static",
  "_next",
  "favicon.ico",
  "new",
  "edit",
  "delete",
]);

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Generates a URL-safe slug from an event title.
 */
export function slugifyEventTitle(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");

  return base;
}

export interface SlugValidationResult {
  valid: boolean;
  slug: string;
  error?: string;
}

/**
 * Validates that an event slug is URL-safe, 2..80 chars, and not a reserved word.
 */
export function validateEventSlug(rawSlug: string): SlugValidationResult {
  const slug = rawSlug.trim().toLowerCase();

  if (slug.length < 2 || slug.length > 80) {
    return {
      valid: false,
      slug,
      error: "Slug must be between 2 and 80 characters.",
    };
  }

  if (!SLUG_REGEX.test(slug)) {
    return {
      valid: false,
      slug,
      error:
        "Slug may only contain lowercase letters, numbers, and single hyphens (e.g. annual-seminar-2026).",
    };
  }

  if (RESERVED_EVENT_SLUGS.has(slug)) {
    return {
      valid: false,
      slug,
      error: `"${slug}" is a reserved word and cannot be used as an event slug.`,
    };
  }

  return { valid: true, slug };
}
