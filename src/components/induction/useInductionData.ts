// induction_state for the shell: read on mount, on every route change, on the
// 'sorted:induction-refresh' event (the success sites dispatch it) and on a 4 s
// poll only while a gated step is active. Writes are optimistic: Next moves the
// card at once and the stored step follows. Restart tour runs the guide again
// after it was done: induction_done_at stays stamped (first finish wins), so a
// tab-scoped replay mark reads the state as not done until the next finish.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  FAIL_OPEN_STATE,
  INDUCTION_POLL_MS,
  INDUCTION_REFRESH_EVENT,
  type InductionState,
} from '@/lib/induction';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { logger } from '@/lib/logger';
import { finishInduction, readInductionState, storeInductionStep } from './induction-data';

export interface InductionData {
  /** 'loading' until the first read for this workspace lands. */
  status: 'loading' | 'ready';
  state: InductionState;
  /** Store the current step (Next, Later, the approver wait). */
  setStep: (step: string) => Promise<boolean>;
  /** Stamp the induction done; skippedAt (Skip tour) is stored as the step first. */
  finish: (skippedAt?: string) => void;
  /** Run the guide again from this card id (the route's intro), done or not. */
  restart: (introId: string) => void;
  /** Poll every 4 s while true (a gated step is up). */
  setPolling: (on: boolean) => void;
}

const REPLAY_KEY = 'srtdio.induction.replay';

function readReplay(): boolean {
  try {
    return window.sessionStorage.getItem(REPLAY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeReplay(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(REPLAY_KEY, '1');
    else window.sessionStorage.removeItem(REPLAY_KEY);
  } catch {
    // Storage off: the replay lasts until the page reloads.
  }
}

export function useInductionData(workspaceId: string | null): InductionData {
  const newTrace = useNewTrace();
  const location = useLocation();
  const [read, setRead] = useState<{ workspaceId: string | null; state: InductionState } | null>(
    null,
  );
  const [polling, setPolling] = useState(false);
  const [replay, setReplay] = useState(readReplay);
  const seq = useRef(0);
  // The step being stored: a read that left before the store landed (a route
  // change right after a tap) must not pull the guide back a step.
  const storing = useRef<{ step: string; storedAt: number | null } | null>(null);

  const refresh = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    const startedAt = performance.now();
    void readInductionState(supabase, { workspaceId, traceId: newTrace() }).then((state) => {
      if (mine !== seq.current) return;
      const guard = storing.current;
      // A read that left before the store landed still says the old step.
      const stale = guard !== null && (guard.storedAt === null || startedAt < guard.storedAt);
      if (guard !== null && !stale) storing.current = null;
      setRead({ workspaceId, state: stale ? { ...state, step: guard.step } : state });
    });
  }, [workspaceId, newTrace]);

  // Route changes (and the workspace itself) refetch.
  useEffect(() => {
    refresh();
  }, [refresh, location.pathname, location.search]);

  useEffect(() => {
    window.addEventListener(INDUCTION_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(INDUCTION_REFRESH_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (!polling) return;
    const id = window.setInterval(refresh, INDUCTION_POLL_MS);
    return () => window.clearInterval(id);
  }, [polling, refresh]);

  const setStep = useCallback(
    async (step: string): Promise<boolean> => {
      seq.current += 1;
      storing.current = { step, storedAt: null };
      setRead((prev) => (prev === null ? prev : { ...prev, state: { ...prev.state, step } }));
      const traceId = newTrace();
      const stored = await storeInductionStep(supabase, { step, traceId });
      if (storing.current?.step === step) storing.current = { step, storedAt: performance.now() };
      if (!stored.ok) {
        logger.warn('induction_step_set failed', {
          error: stored.error.message,
          trace_id: traceId,
        });
        return false;
      }
      refresh();
      return true;
    },
    [newTrace, refresh],
  );

  const finish = useCallback(
    (skippedAt?: string) => {
      seq.current += 1;
      writeReplay(false);
      setReplay(false);
      setRead((prev) => (prev === null ? prev : { ...prev, state: { ...prev.state, done: true } }));
      const traceId = newTrace();
      // Skip tour: the step records where it was skipped, then the finish stamps done.
      const recorded =
        skippedAt === undefined
          ? Promise.resolve()
          : storeInductionStep(supabase, { step: skippedAt, traceId }).then((res) => {
              if (res.ok) logger.info('induction skipped', { step: skippedAt, trace_id: traceId });
              else
                logger.warn('induction_step_set failed', {
                  error: res.error.message,
                  trace_id: traceId,
                });
            });
      void recorded
        .then(() => finishInduction(supabase, traceId))
        .then((res) => {
          if (!res.ok)
            logger.warn('induction_finish failed', { error: res.error.message, trace_id: traceId });
        });
    },
    [newTrace],
  );

  const restart = useCallback(
    (introId: string) => {
      writeReplay(true);
      setReplay(true);
      void setStep(introId);
    },
    [setStep],
  );

  const current = read !== null && read.workspaceId === workspaceId ? read.state : null;
  const state = current !== null && replay ? { ...current, done: false } : current;
  return {
    status: state === null ? 'loading' : 'ready',
    state: state ?? FAIL_OPEN_STATE,
    setStep,
    finish,
    restart,
    setPolling,
  };
}
