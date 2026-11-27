export interface DeletionDbAdapter {
  getEventScopedPaths(
    orgId: string,
    eventId: string,
  ): Promise<{
    templatePaths: string[];
    proofPaths: string[];
  }>;
  removeStorageObjects(bucket: "templates" | "payment-proofs", paths: string[]): Promise<void>;
  purgeEventRows(orgId: string, eventId: string, actorUserId: string): Promise<{
    attendeesDeleted: number;
  }>;
  getOrgScopedPaths(orgId: string): Promise<{
    templatePaths: string[];
    proofPaths: string[];
  }>;
  purgeOrganizationRows(orgId: string): Promise<void>;
}

/**
 * Filters storage paths strictly to `<orgId>/...` so deletion can NEVER touch another tenant's files.
 */
export function filterSafeOrgPaths(
  orgId: string,
  rawPaths: Array<string | null | undefined>,
): string[] {
  const prefix = `${orgId}/`;
  const unique = new Set<string>();
  for (const p of rawPaths) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (!trimmed || !trimmed.startsWith(prefix) || trimmed.includes("..")) {
      continue;
    }
    unique.add(trimmed);
  }
  return [...unique];
}

export async function executeEventDataPurge(params: {
  orgId: string;
  eventId: string;
  actorUserId: string;
  adapter: DeletionDbAdapter;
}): Promise<{
  attendeesDeleted: number;
  templateFilesRemoved: number;
  proofFilesRemoved: number;
}> {
  const { orgId, eventId, actorUserId, adapter } = params;
  const raw = await adapter.getEventScopedPaths(orgId, eventId);
  const templatePaths = filterSafeOrgPaths(orgId, raw.templatePaths);
  const proofPaths = filterSafeOrgPaths(orgId, raw.proofPaths);

  if (templatePaths.length > 0) {
    await adapter.removeStorageObjects("templates", templatePaths);
  }
  if (proofPaths.length > 0) {
    await adapter.removeStorageObjects("payment-proofs", proofPaths);
  }

  const { attendeesDeleted } = await adapter.purgeEventRows(
    orgId,
    eventId,
    actorUserId,
  );

  return {
    attendeesDeleted,
    templateFilesRemoved: templatePaths.length,
    proofFilesRemoved: proofPaths.length,
  };
}

export async function executeOrganizationDeletion(params: {
  orgId: string;
  adapter: DeletionDbAdapter;
}): Promise<{
  templateFilesRemoved: number;
  proofFilesRemoved: number;
}> {
  const { orgId, adapter } = params;
  const raw = await adapter.getOrgScopedPaths(orgId);
  const templatePaths = filterSafeOrgPaths(orgId, raw.templatePaths);
  const proofPaths = filterSafeOrgPaths(orgId, raw.proofPaths);

  if (templatePaths.length > 0) {
    await adapter.removeStorageObjects("templates", templatePaths);
  }
  if (proofPaths.length > 0) {
    await adapter.removeStorageObjects("payment-proofs", proofPaths);
  }

  await adapter.purgeOrganizationRows(orgId);

  return {
    templateFilesRemoved: templatePaths.length,
    proofFilesRemoved: proofPaths.length,
  };
}
