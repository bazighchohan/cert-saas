import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { TEMPLATE_FILE } from "@/lib/config";
import { assertOrgScopedStoragePath } from "@/lib/security-helpers";
import { getSupabaseAdmin } from "@/lib/supabase";

const MAX_STORAGE_CACHE_ENTRIES = 32;
const storageTemplateBytesCache = new Map<string, Promise<Uint8Array>>();

/**
 * Fetches raw template bytes from the private Supabase Storage "templates" bucket
 * using the server-only service role key, enforcing `{orgId}/` path scoping and
 * caching bytes per server instance.
 *
 * If `templatePath` is null/empty, loads the bundled blank sample PDF.
 */
export function fetchTemplateBytesFromStorage(params: {
  orgId: string;
  eventId?: string;
  templatePath: string | null | undefined;
}): Promise<Uint8Array> {
  const { orgId, eventId, templatePath } = params;

  if (!templatePath) {
    const fallbackKey = "__sample_blank_template__";
    const cachedSample = storageTemplateBytesCache.get(fallbackKey);
    if (cachedSample) return cachedSample;

    const samplePromise = readFile(
      path.join(process.cwd(), "public", TEMPLATE_FILE),
    ).then((b) => new Uint8Array(b));
    storageTemplateBytesCache.set(fallbackKey, samplePromise);
    return samplePromise;
  }

  try {
    assertOrgScopedStoragePath({
      orgId,
      eventId,
      objectPath: templatePath,
    });
  } catch (err) {
    return Promise.reject(err);
  }

  const cached = storageTemplateBytesCache.get(templatePath);
  if (cached) {
    storageTemplateBytesCache.delete(templatePath);
    storageTemplateBytesCache.set(templatePath, cached);
    return cached;
  }

  const downloadPromise = (async () => {
    const admin = getSupabaseAdmin();
    const { data: blob, error } = await admin.storage
      .from("templates")
      .download(templatePath);

    if (error || !blob) {
      throw new Error(
        error?.message || "Could not download certificate template from Storage.",
      );
    }

    return new Uint8Array(await blob.arrayBuffer());
  })().catch((err) => {
    storageTemplateBytesCache.delete(templatePath);
    throw err;
  });

  if (storageTemplateBytesCache.size >= MAX_STORAGE_CACHE_ENTRIES) {
    const oldest = storageTemplateBytesCache.keys().next().value;
    if (oldest) storageTemplateBytesCache.delete(oldest);
  }

  storageTemplateBytesCache.set(templatePath, downloadPromise);
  return downloadPromise;
}

export function invalidateCachedStorageTemplate(templatePath: string) {
  storageTemplateBytesCache.delete(templatePath);
}
