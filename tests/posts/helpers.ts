// A minimal, typed stand-in for the Supabase client's `.rpc()` surface. The
// posts wrappers call the real @srtdio/rpc layer (callProc / toDomainError); we
// only swap the transport, so these specs exercise the genuine proc-error
// mapping rather than a mock of it. Each call is recorded so a test can assert
// exactly what was sent, or that the proc was never reached.

import type { Client } from '../../packages/posts/src/index';

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export function rpcClient(result: RpcResult): { client: Client; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  } as unknown as Client;
  return { client, calls };
}

/** A client whose `.rpc()` fails the test if it is ever called. */
export function unreachableRpcClient(): Client {
  return {
    rpc(): never {
      throw new Error('rpc should not have been called');
    },
  } as unknown as Client;
}
