// stageTransition's on-behalf plumbing: p_on_behalf_of rides only an approve,
// and only when given; every other call keeps the three-arg shape.

import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { stageTransition } from './stage-machine';

function fakeClient(): { client: Client; calls: Array<{ fn: string; args: unknown }> } {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client = {
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve({ data: 'p-1', error: null });
    },
  } as unknown as Client;
  return { client, calls };
}

describe('stageTransition onBehalfOf', () => {
  it('sends p_on_behalf_of on an approve', async () => {
    const { client, calls } = fakeClient();
    await stageTransition(client, {
      postId: 'p-1',
      toStage: 'approved',
      traceId: 't-1',
      onBehalfOf: 'u-client',
    });
    expect(calls[0]).toEqual({
      fn: 'stage_transition',
      args: { p_post_id: 'p-1', p_to_stage: 'approved', p_trace_id: 't-1', p_on_behalf_of: 'u-client' },
    });
  });

  it('leaves p_on_behalf_of out when not given', async () => {
    const { client, calls } = fakeClient();
    await stageTransition(client, { postId: 'p-1', toStage: 'approved', traceId: 't-1' });
    expect(calls[0]!.args).toEqual({ p_post_id: 'p-1', p_to_stage: 'approved', p_trace_id: 't-1' });
  });

  it('never sends p_on_behalf_of for a non-approve move', async () => {
    const { client, calls } = fakeClient();
    await stageTransition(client, {
      postId: 'p-1',
      toStage: 'parked',
      traceId: 't-1',
      onBehalfOf: 'u-client',
    });
    expect(calls[0]!.args).toEqual({ p_post_id: 'p-1', p_to_stage: 'parked', p_trace_id: 't-1' });
  });
});
