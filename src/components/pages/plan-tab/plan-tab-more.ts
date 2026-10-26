// The phone list's Load more, handed from the tab's data hook (usePlanTabData,
// which owns the cursor and the appended pages) to the list (PlanTabList,
// which draws the control at its end). One Plan tab is mounted at a time, so
// one module-level slot holds it; the hook clears it on unmount. In memory
// only.

import { useSyncExternalStore } from 'react';

/** What the list's Load more needs: busy while a page is in flight, and the tap. */
export interface PlanTabMore {
  busy: boolean;
  onMore: () => void;
}

let current: PlanTabMore | null = null;
const listeners = new Set<() => void>();

/** Set (or clear, with null) the list's Load more. */
export function setPlanTabMore(next: PlanTabMore | null): void {
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** The list's Load more right now; null when every plan is in (no control). */
export function getPlanTabMore(): PlanTabMore | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The list's Load more, re-rendering when it changes. */
export function usePlanTabMore(): PlanTabMore | null {
  return useSyncExternalStore(subscribe, getPlanTabMore, getPlanTabMore);
}
