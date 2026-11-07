// The Bank's select mode, held by PlanTabPage so the chip row's Select
// (SectionHeader select, SectionSelect) and the Bank's cards share it. It is
// ui/SelectBar's useListSelection (long-press / right-click enter with the card
// ticked, a tap toggles, Cancel, Esc and Back leave) plus one flag: the visible
// Select starts select mode with nothing ticked yet (the bar reads
// "0 selected", its actions disabled until a card is ticked). A second tap on
// Select, the bar's Cancel or any finished action leaves. Pure client state:
// no await, no read.

import { useCallback, useMemo, useState } from 'react';
import { useListSelection, type ListSelection } from '@/components/ui/SelectBar';
import type { ListCardSelect } from '@/components/ui/ListCard';

export interface BankSelection extends ListSelection {
  /** The chip row's Select: start select mode (nothing ticked), or leave it. */
  toggleMode: () => void;
}

export function useBankSelect(): BankSelection {
  const base = useListSelection();
  const [armed, setArmed] = useState(false);
  const active = armed || base.active;
  const baseClear = base.clear;
  const baseLeaveThen = base.leaveThen;
  const baseSelectFor = base.selectFor;
  const clear = useCallback(() => {
    setArmed(false);
    baseClear();
  }, [baseClear]);
  const leaveThen = useCallback(
    (then: () => void) => {
      setArmed(false);
      baseLeaveThen(then);
    },
    [baseLeaveThen],
  );
  // Armed with nothing ticked: a tap on a card ticks it (toggle adds it).
  const selectFor = useCallback(
    (id: string): ListCardSelect => ({ ...baseSelectFor(id), active }),
    [baseSelectFor, active],
  );
  const toggleMode = useCallback(() => {
    if (active) clear();
    else setArmed(true);
  }, [active, clear]);
  return useMemo(
    () => ({ ...base, active, clear, leaveThen, selectFor, toggleMode }),
    [base, active, clear, leaveThen, selectFor, toggleMode],
  );
}
