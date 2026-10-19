// The Back guard for unsaved work. While `active`, system or browser Back does
// not leave the screen: the entry comes straight back and `onBack` runs, so
// the caller can ask (its own discard confirm). The caller runs release()
// right before a confirmed close; after it, the next Back or programmatic
// close behaves exactly as without the guard.
//
// It is one step in the chat history-step stack (src/lib/chat/use-history-step.ts,
// where the generic mechanics live): inside chat it sits above the layer's
// own step, so Back pops the guard, never the layer; on any other page it is
// the only step, and Back stays on the route. While active, beforeunload asks
// the browser's leave prompt on a reload or tab close (desktop browsers;
// iOS Safari mostly ignores it).

import { useEffect, useMemo, useRef } from 'react';
import {
  BACK_GUARD_STEP_KEY,
  enterHistoryStep,
  type HistoryStep,
  type HistoryStepWindow,
} from '@/lib/chat/use-history-step';

export { BACK_GUARD_STEP_KEY };

export interface BackGuardOptions {
  /** Guard while true (the sheet is open with unsaved input, or a save is in flight). */
  active: boolean;
  /** Back was pressed while active: the screen stayed; open the confirm. */
  onBack: () => void;
}

export interface BackGuardControl {
  /** Drop the guard now (right before a confirmed close). Safe to call twice. */
  release: () => void;
}

/** The guard as a bare step over `win` (the hook's engine; tests drive a fake window). */
export function enterBackGuard(win: HistoryStepWindow, onBack: () => void): HistoryStep {
  return enterHistoryStep(win, BACK_GUARD_STEP_KEY, onBack, { guard: true });
}

/** The browser's own leave prompt on reload or tab close. */
function askBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Legacy browsers read this; modern ones only need preventDefault.
  event.returnValue = '';
}

export function useBackGuard({ active, onBack }: BackGuardOptions): BackGuardControl {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const stepRef = useRef<HistoryStep | null>(null);
  // release() before the step was placed: never place it.
  const releasedRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    releasedRef.current = false;
    let step: HistoryStep | null = null;
    let cancelled = false;
    // Placed after this commit's effects have all run: a layer that opens
    // already guarded (its parent's useHistoryStep runs after this child
    // effect) still gets its own step under the guard, never above it.
    queueMicrotask(() => {
      if (cancelled || releasedRef.current) return;
      step = enterBackGuard(window, () => onBackRef.current());
      stepRef.current = step;
    });
    window.addEventListener('beforeunload', askBeforeUnload);
    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', askBeforeUnload);
      if (stepRef.current === step) stepRef.current = null;
      step?.dispose();
    };
  }, [active]);

  return useMemo(
    () => ({
      release: () => {
        releasedRef.current = true;
        stepRef.current?.dispose();
        stepRef.current = null;
      },
    }),
    [],
  );
}
