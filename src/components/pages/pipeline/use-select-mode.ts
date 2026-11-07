// The visible Select toggle (decision E, SectionSelect) over a list's select
// mode (ui/SelectBar useListSelection). useListSelection is on only while a
// card is ticked; the Select tap has to enter select mode with nothing ticked,
// so this holds that one extra "armed" flag beside it. Pure client state: no
// await, no read, no gate on the tap path.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListCardSelect } from '@/components/ui/ListCard';
import type { ListSelection } from '@/components/ui/SelectBar';

/** Select mode is on: armed by the Select tap, or a card is ticked. Pure. */
export function selectModeOn(armed: boolean, ticked: boolean): boolean {
  return armed || ticked;
}

/** A card's `select` while select mode may be armed with none ticked. Pure. */
export function armedSelect(base: ListCardSelect, on: boolean): ListCardSelect {
  return base.active === on ? base : { ...base, active: on };
}

export interface SelectMode {
  /** Select mode is on (the SectionSelect is pressed; the SelectBar shows). */
  on: boolean;
  /** The SectionSelect tap: enter with nothing ticked, or leave. */
  toggle: () => void;
  /** Leave select mode (the SelectBar's Cancel, a finished action). */
  clear: () => void;
  /** The ListCard `select` prop for one card; a tap ticks it while armed. */
  selectFor: (id: string) => ListCardSelect;
}

/**
 * Wrap a list's selection with the Select toggle. Long-press / right-click
 * keep entering through the selection itself. Unticking the last card leaves
 * select mode as before; Esc leaves an armed, empty select mode on laptop.
 */
export function useSelectMode(selection: ListSelection): SelectMode {
  const [armed, setArmed] = useState(false);
  const ticked = selection.active;
  const wasTicked = useRef(ticked);
  // The selection left (last card unticked, Cancel, Back, Esc): so does select mode.
  useEffect(() => {
    if (wasTicked.current && !ticked) setArmed(false);
    wasTicked.current = ticked;
  }, [ticked]);
  const on = selectModeOn(armed, ticked);
  // Armed with none ticked holds no Back entry; Esc still leaves.
  useEffect(() => {
    if (!armed || ticked) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setArmed(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, ticked]);
  const { clear: clearSelection, selectFor: baseSelectFor } = selection;
  const clear = useCallback((): void => {
    setArmed(false);
    clearSelection();
  }, [clearSelection]);
  const toggle = useCallback((): void => {
    if (on) clear();
    else setArmed(true);
  }, [on, clear]);
  const selectFor = useCallback(
    (id: string): ListCardSelect => armedSelect(baseSelectFor(id), on),
    [baseSelectFor, on],
  );
  return useMemo(() => ({ on, toggle, clear, selectFor }), [on, toggle, clear, selectFor]);
}
