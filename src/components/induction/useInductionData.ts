// induction_state for the shell: read on mount (and per workspace), on the
// 'sorted:induction-refresh' event (the success sites dispatch it), on a 4 s
// poll only while a gated step is active, and on a route change only while the
// guide is live (the tour is running, or the last read failed and needs to
// heal). A person who finished the tour reads it once per shell mount, never
// per navigation. Writes are optimistic: Next moves the
// card at once and the stored step follows. Restart tour runs the guide again
// after it was done: induction_done_at stays stamped (first finish wins), so a
// tab-scoped replay mark reads the state as not done until the next finish.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  FAIL_OPEN_STATE,
  approverStageOf,
  INDUCTION_POLL_MS,
  INDUCTION_REFRESH_EVENT,
  type InductionState,
} from '@/lib/induction';
import { routeFor } from '@/lib/induction-routes';
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

/**
 * Whether a route change should read induction_state again: only while the
 * guide (or the onboarding it gates) can still move. Not read yet: the mount
 * read is out, a second would only race it. The fail-open state (a failed or
 * malformed read, by identity): a route change heals it, as before. Done (and
 * not replaying), or a role with no route: the guide never shows, so the route
 * change reads nothing.
 */
export function readsOnRouteChange(state: InductionState | null, hasWorkspace: boolean): boolean {
  if (state === null) return false;
  if (state === FAIL_OPEN_STATE) return true;
  if (state.done) return false;
  if (approverStageOf(state) !== 'none') return true;
  return routeFor({ role: state.role, hasWorkspace }) !== 'none';
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

  // Mount and the workspace itself read.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // A route change reads again only while the guide is live (see readsOnRouteChange).
  const routeKey = `${location.pathname}${location.search}`;
  const lastRoute = useRef(routeKey);
  const liveRef = useRef(false);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    if (liveRef.current) refresh();
  }, [routeKey, refresh]);

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
  // The fail-open check reads the stored read itself (a replay copies it).
  liveRef.current = readsOnRouteChange(
    current === FAIL_OPEN_STATE ? current : state,
    workspaceId !== null,
  );
  return {
    status: state === null ? 'loading' : 'ready',
    state: state ?? FAIL_OPEN_STATE,
    setStep,
    finish,
    restart,
    setPolling,
  };
}
