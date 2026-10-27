// The Cockpit's session memory: open or closed, the last tab, the dot and the
// last answer per tab. Module state (never storage): the panel reopens on the
// tab it was left on and paints its last result on the first frame, then the
// poller refreshes it. Lives in the lazy Cockpit chunk only.

import { useSyncExternalStore } from 'react';
import type { CockpitAlert, CockpitFull, CockpitTab, DotLevel } from '@/lib/cockpit/types';

export interface CockpitState {
  open: boolean;
  /** The last tab picked this session; Needs you on the first open. */
  tab: CockpitTab;
  /** Grey until the first answer; then the worst open alert. */
  level: DotLevel;
  /** The last full answer per tab, painted instantly when that tab shows. */
  byTab: Partial<Record<CockpitTab, CockpitFull>>;
  /** The newest full answer of any tab: tiles and alerts. */
  latest: CockpitFull | null;
  /** The open alerts from the newest answer (status or full); null before one. */
  alerts: CockpitAlert[] | null;
  /** When the newest answer (status or full) was checked. */
  checkedAt: string | null;
}

const INITIAL: CockpitState = {
  open: false,
  tab: 'needs',
  level: 'grey',
  byTab: {},
  latest: null,
  alerts: null,
  checkedAt: null,
};

let state: CockpitState = INITIAL;
const listeners = new Set<() => void>();

export function getCockpitState(): CockpitState {
  return state;
}

export function setCockpitState(patch: Partial<CockpitState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeCockpit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: back to a fresh session. */
export function resetCockpitState(): void {
  state = INITIAL;
  for (const listener of listeners) listener();
}

export function useCockpitState(): CockpitState {
  return useSyncExternalStore(subscribeCockpit, getCockpitState, getCockpitState);
}
