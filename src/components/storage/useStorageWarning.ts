// The storage warning for the active workspace, for every member. The Worker
// decides whether to warn (exempt owners never do); the client only reads.
// Re-read after any successful upload anywhere via UPLOAD_COMPLETE_EVENT.
//
// The shell's banner and Settings both read usage: the GET /usage is a
// session-shared read (src/lib/session-read.ts) per user and workspace, so the
// two ask once per freshness window. A failed read (null) is not kept. An
// upload drops the shared value first (one module listener, registered before
// any hook's), so every hook's re-read after it joins one new request.

import { useCallback, useEffect, useRef, useState } from 'react';
import { UPLOAD_COMPLETE_EVENT, type UploadCompleteDetail } from '@/lib/asset-upload';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { invalidateReads, readKey, sharedRead } from '@/lib/session-read';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import {
  fetchStorageUsage,
  readWarningDismissed,
  writeWarningDismissed,
  type StorageUsage,
} from './storage-usage';

/** The session read key's last part; the user and workspace come first. */
const USAGE_READ = 'storage-usage';

// Registered at module load, so it runs before every hook's own upload
// listener: the old reading is gone before any of them re-reads.
if (typeof window !== 'undefined') {
  window.addEventListener(UPLOAD_COMPLETE_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<UploadCompleteDetail>).detail;
    // Every user's key for that workspace (only the signed-in user's exists).
    invalidateUsageFor(detail.workspaceId);
  });
}

const usageKeys = new Set<string>();

function invalidateUsageFor(workspaceId: string): void {
  for (const key of [...usageKeys]) {
    if (key.endsWith(`:${workspaceId}:${USAGE_READ}`)) {
      invalidateReads(key);
      usageKeys.delete(key);
    }
  }
}

/**
 * GET /usage for (user, workspace), shared per session window: concurrent and
 * fresh callers join one request. Null (no endpoint, no token, a failure) is
 * never kept.
 */
export function readStorageUsageShared(
  userId: string,
  workspaceId: string,
  load: () => Promise<StorageUsage | null>,
): Promise<StorageUsage | null> {
  const key = readKey(userId, workspaceId, USAGE_READ);
  usageKeys.add(key);
  return sharedRead(key, load, { isOk: (value) => value !== null });
}

interface StorageWarningState {
  /** The reading, or null when unknown or failed. */
  usage: StorageUsage | null;
  dismissed: boolean;
  dismiss: () => void;
}

export function useStorageWarning(): StorageWarningState {
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  // Held in a ref so a new trace factory never re-runs the read effect.
  const newTraceRef = useRef(newTrace);
  newTraceRef.current = newTrace;
  const userId = session?.user.id ?? null;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const read = useCallback(async (): Promise<StorageUsage | null> => {
    const endpoint = env.VITE_ASSET_UPLOAD_URL;
    if (workspaceId === null || userId === null || endpoint === undefined || endpoint === '') {
      return null;
    }
    return readStorageUsageShared(userId, workspaceId, async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
        if (token === null || token === '') return null;
        return await fetchStorageUsage({
          endpoint,
          token,
          workspaceId,
          fetcher: (url, init) => fetchWithTrace(url, init, newTraceRef.current()),
        });
      } catch (err: unknown) {
        logger.warn('storage usage read failed', { error: String(err) });
        return null;
      }
    });
  }, [workspaceId, userId]);

  useEffect(() => {
    setUsage(null);
    setDismissed(
      workspaceId !== null && userId !== null && readWarningDismissed(workspaceId, userId),
    );
    let active = true;
    const load = (): void => {
      void read().then((next) => {
        if (active) setUsage(next);
      });
    };
    const onUploaded = (event: Event): void => {
      const detail = (event as CustomEvent<UploadCompleteDetail>).detail;
      if (detail.workspaceId === workspaceId) load();
    };
    load();
    window.addEventListener(UPLOAD_COMPLETE_EVENT, onUploaded);
    return () => {
      active = false;
      window.removeEventListener(UPLOAD_COMPLETE_EVENT, onUploaded);
    };
  }, [read, workspaceId, userId]);

  const dismiss = useCallback(() => {
    if (workspaceId !== null && userId !== null) writeWarningDismissed(workspaceId, userId);
    setDismissed(true);
  }, [workspaceId, userId]);

  return { usage, dismissed, dismiss };
}
