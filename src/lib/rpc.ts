import { supabase } from '@/lib/supabase';

/**
 * Call a Postgres RPC function with a mandatory trace_id.
 *
 * Every RPC function accepts `_trace_id` as an explicit parameter (PRD section
 * 24, Schema section 1). This is the explicit-RPC-parameter pattern: trace_id
 * is NEVER set via `SET LOCAL` because pgBouncer transaction pooling makes it
 * unsafe. Prefer callRpc() over raw supabase.rpc(); ESLint enforces _trace_id.
 */
export async function callRpc<T>(
  fn: string,
  params: Record<string, unknown>,
  traceId: string,
): Promise<T> {
  if (!traceId) {
    throw new Error(`callRpc("${fn}") requires a non-empty trace_id`);
  }

  const { data, error } = await supabase.rpc(fn, { ...params, _trace_id: traceId });
  if (error) {
    throw error;
  }
  return data as T;
}
