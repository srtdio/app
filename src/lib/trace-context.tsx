import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { generateTraceId, getCurrentTraceId, setCurrentTraceId } from '@/lib/trace';
import { setSentryTraceId } from '@/lib/sentry';

/**
 * A trace_id scopes one top-level user action (page load, click, form submit).
 * It is generated fresh at action boundaries via useNewTrace().
 */
interface TraceContextValue {
  traceId: string;
  newTrace: () => string;
}

const TraceContext = createContext<TraceContextValue | null>(null);

export function TraceProvider({ children }: { children: ReactNode }) {
  const [traceId, setTraceId] = useState<string>(getCurrentTraceId);

  // Keep the module-level holder and Sentry tag in sync with the active id so
  // the Supabase fetch wrapper and captured errors carry the same trace_id.
  useEffect(() => {
    setCurrentTraceId(traceId);
    setSentryTraceId(traceId);
  }, [traceId]);

  const newTrace = useCallback(() => {
    const next = generateTraceId();
    setTraceId(next);
    return next;
  }, []);

  const value = useMemo<TraceContextValue>(() => ({ traceId, newTrace }), [traceId, newTrace]);

  return <TraceContext.Provider value={value}>{children}</TraceContext.Provider>;
}

export function useTraceId(): string {
  const ctx = useContext(TraceContext);
  if (!ctx) {
    throw new Error('useTraceId must be used within a TraceProvider');
  }
  return ctx.traceId;
}

export function useNewTrace(): () => string {
  const ctx = useContext(TraceContext);
  if (!ctx) {
    throw new Error('useNewTrace must be used within a TraceProvider');
  }
  return ctx.newTrace;
}
