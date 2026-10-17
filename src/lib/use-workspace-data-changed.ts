import { useEffect, useRef } from 'react';
import { WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';

/**
 * Runs onChange whenever the workspace's rows changed under the open screen
 * (dispatchWorkspaceDataChanged): a list that fetched on mount re-reads. The
 * latest onChange is used; the listener itself is attached once.
 */
export function useWorkspaceDataChanged(onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const handler = (): void => latest.current();
    window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_DATA_CHANGED_EVENT, handler);
  }, []);
}
