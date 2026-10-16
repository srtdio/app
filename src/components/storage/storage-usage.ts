// The storage warning's pure pieces: the copy, the asset-upload Worker's GET
// /usage body and read, and the per viewer, per device dismissal.

import { logger } from '@/lib/logger';

const BYTES_PER_MB = 1024 * 1024;

export const DELETED_FILES_LINE = 'Deleted files still count toward storage.';

function wholeMb(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_MB);
}

/** The one storage warning line. */
export function storageWarningCopy(usedBytes: number): string {
  return `This workspace has used ${wholeMb(usedBytes)} MB of its 1 GB. ${DELETED_FILES_LINE}`;
}

/** The usage figure Settings shows. */
export function storageUsedLine(usedBytes: number): string {
  return `${wholeMb(usedBytes)} MB of 1 GB used`;
}

/** The asset-upload Worker's GET /usage body. */
export interface StorageUsage {
  usedBytes: number;
  warnAtBytes: number;
  warn: boolean;
  exempt: boolean;
}

/** A well-formed /usage body, or null (the UI then shows nothing). */
export function parseStorageUsage(body: unknown): StorageUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (
    typeof r.usedBytes !== 'number' ||
    typeof r.warnAtBytes !== 'number' ||
    typeof r.warn !== 'boolean' ||
    typeof r.exempt !== 'boolean'
  ) {
    return null;
  }
  return { usedBytes: r.usedBytes, warnAtBytes: r.warnAtBytes, warn: r.warn, exempt: r.exempt };
}

/** GET {endpoint}/usage for a workspace. Never throws; any failure is null. */
export async function fetchStorageUsage(input: {
  endpoint: string;
  token: string;
  workspaceId: string;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<StorageUsage | null> {
  try {
    const base = input.endpoint.replace(/\/+$/, '');
    const url = `${base}/usage?workspace_id=${encodeURIComponent(input.workspaceId)}`;
    const res = await input.fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.token}` },
    });
    if (!res.ok) return null;
    return parseStorageUsage(await res.json());
  } catch (err: unknown) {
    logger.warn('storage usage read failed', { error: String(err) });
    return null;
  }
}

function dismissKey(workspaceId: string, userId: string): string {
  return `sorted:storage-warning-dismissed:${workspaceId}:${userId}`;
}

/** Whether this viewer dismissed the warning for this workspace on this device. */
export function readWarningDismissed(workspaceId: string, userId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(workspaceId, userId)) === '1';
  } catch {
    return false;
  }
}

export function writeWarningDismissed(workspaceId: string, userId: string): void {
  try {
    localStorage.setItem(dismissKey(workspaceId, userId), '1');
  } catch {
    // Storage blocked: the banner just closes for this visit.
  }
}
