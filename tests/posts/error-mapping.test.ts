// Proc-error mapping. The wrappers do not re-map errors themselves: they hand
// the raw PostgREST message to the shared @srtdio/rpc layer, exactly as the
// briefs and comments packages do. These specs drive a fake transport that
// returns each domain message and assert the wrappers surface the matching
// DomainError code, with anything unrecognised collapsing to 'unknown'.

import { describe, expect, it } from 'vitest';
import { postCreate, stageTransition } from '../../packages/posts/src/index';
import { rpcClient } from './helpers';

const validPayload = { title: 'T', platform: 'linkedin' } as const;

describe('post_create error mapping', () => {
  const cases: Array<[string, string]> = [
    ['invalid_payload', 'invalid_payload'],
    ['forbidden_role', 'forbidden_role'],
    ['workspace_member_only', 'workspace_member_only'],
  ];

  for (const [message, code] of cases) {
    it(`maps a proc ${message} message to the ${code} domain error`, async () => {
      const { client } = rpcClient({ data: null, error: { message } });
      const result = await postCreate(client, { workspaceId: 'ws-1', payload: validPayload });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.message).toBe(message);
      }
    });
  }

  it('collapses an unrecognised message to unknown', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'boom' } });
    const result = await postCreate(client, { workspaceId: 'ws-1', payload: validPayload });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown');
  });

  it('returns the proc id on success', async () => {
    const { client } = rpcClient({ data: 'post-9', error: null });
    const result = await postCreate(client, { workspaceId: 'ws-1', payload: validPayload });
    expect(result).toEqual({ ok: true, data: 'post-9' });
  });
});

describe('stage_transition error mapping', () => {
  it('maps invalid_stage_transition to the matching domain error', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'invalid_stage_transition' } });
    const result = await stageTransition(client, { postId: 'p-1', toStage: 'approved' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_stage_transition');
  });

  it('passes the post id, target stage, and a trace id through', async () => {
    const { client, calls } = rpcClient({ data: 'p-1', error: null });
    await stageTransition(client, { postId: 'p-1', toStage: 'review', traceId: 'trace-7' });
    expect(calls[0]!.fn).toBe('stage_transition');
    expect(calls[0]!.args).toEqual({
      p_post_id: 'p-1',
      p_to_stage: 'review',
      p_trace_id: 'trace-7',
    });
  });
});
