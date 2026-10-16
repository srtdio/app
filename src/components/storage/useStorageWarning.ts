// The storage warning for the active workspace, for every member. The Worker
// decides whether to warn (exempt owners never do); the client only reads.
// Re-read after any successful upload anywhere via UPLOAD_COMPLETE_EVENT.

import { useCallback, useEffect, useRef, useState } from 'react';
import { UPLOAD_COMPLETE_EVENT, type UploadCompleteDetail } from '@/lib/asset-upload';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
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

export interface StorageWarningState {
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
    if (workspaceId === null || endpoint === undefined || endpoint === '') return null;
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
  }, [workspaceId]);

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
