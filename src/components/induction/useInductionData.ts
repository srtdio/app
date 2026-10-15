// induction_state for the shell: read on mount, on every route change, on the
// 'sorted:induction-refresh' event (the success sites dispatch it) and on a 4 s
// poll only while a gated step is active. Writes are optimistic: Next moves the
// card at once and the stored step follows.

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
  /** Stamp the induction done. */
  finish: () => void;
  /** Poll every 4 s while true (a gated step is up). */
  setPolling: (on: boolean) => void;
}

export function useInductionData(workspaceId: string | null): InductionData {
  const newTrace = useNewTrace();
  const location = useLocation();
  const [read, setRead] = useState<{ workspaceId: string | null; state: InductionState } | null>(
    null,
  );
  const [polling, setPolling] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    void readInductionState(supabase, { workspaceId, traceId: newTrace() }).then((state) => {
      if (mine === seq.current) setRead({ workspaceId, state });
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
      setRead((prev) => (prev === null ? prev : { ...prev, state: { ...prev.state, step } }));
      const traceId = newTrace();
      const stored = await storeInductionStep(supabase, { step, traceId });
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

  const finish = useCallback(() => {
    seq.current += 1;
    setRead((prev) => (prev === null ? prev : { ...prev, state: { ...prev.state, done: true } }));
    const traceId = newTrace();
    void finishInduction(supabase, traceId).then((res) => {
      if (!res.ok)
        logger.warn('induction_finish failed', { error: res.error.message, trace_id: traceId });
    });
  }, [newTrace]);

  const current = read !== null && read.workspaceId === workspaceId ? read.state : null;
  return {
    status: current === null ? 'loading' : 'ready',
    state: current ?? FAIL_OPEN_STATE,
    setStep,
    finish,
    setPolling,
  };
}
