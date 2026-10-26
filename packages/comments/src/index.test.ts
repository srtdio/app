// invalid_mention has two sources, one result shape: createComment's own
// membership pre-check, and comment_create's RAISE 'invalid_mention' (a
// non-member, or a client tagged on a draft post) whose ids ride in the Postgres
// DETAIL. Both come back as { code: 'invalid_mention', message, invalidMentions }.

import { describe, expect, it, vi } from 'vitest';
import {
  createComment,
  invalidMentionError,
  isInvalidMention,
  parseInvalidMentionDetail,
  type Client,
  type CommentError,
} from './index';

const WS = 'ws-1';
const POST = 'post-1';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '99999999-9999-4999-8999-999999999999';

interface RpcError {
  message: string;
  details: string | null;
}

function makeClient(opts: { activeIds: string[]; rpc: { data: unknown; error: RpcError | null } }) {
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<unknown>>(
    async () => opts.rpc,
  );
  const from = vi.fn(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: async () => ({ data: opts.activeIds.map((user_id) => ({ user_id })), error: null }),
    };
    return chain;
  });
  return { client: { from, rpc } as unknown as Client, rpc, from };
}

function input(body: string) {
  return { workspace_id: WS, entity_type: 'post' as const, entity_id: POST, body, trace_id: 't' };
}

function expectInvalidMention(error: CommentError, ids: string[]): void {
  expect(error.code).toBe('invalid_mention');
  expect(typeof error.message).toBe('string');
  expect(error.invalidMentions).toEqual(ids);
  expect(isInvalidMention(error)).toBe(true);
}

describe('createComment invalid_mention: one shape from both sources', () => {
  it('the client pre-check returns the non-member ids without calling the proc', async () => {
    const { client, rpc } = makeClient({
      activeIds: [MEMBER],
      rpc: { data: 'never', error: null },
    });
    const result = await createComment(client, input(`hi @[${MEMBER}] and @[${OUTSIDER}]`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectInvalidMention(result.error, [OUTSIDER]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('the server raise with a DETAIL returns the ids parsed from it', async () => {
    const { client, rpc } = makeClient({
      activeIds: [MEMBER, CLIENT],
      rpc: {
        data: null,
        error: { message: 'invalid_mention', details: `${CLIENT},${MEMBER.toUpperCase()}` },
      },
    });
    const result = await createComment(client, input(`over to @[${CLIENT}] @[${MEMBER}]`));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectInvalidMention(result.error, [CLIENT, MEMBER]);
  });

  it('the server raise without a DETAIL returns an empty id list, same shape', async () => {
    const { client } = makeClient({
      activeIds: [CLIENT],
      rpc: { data: null, error: { message: 'invalid_mention', details: null } },
    });
    const result = await createComment(client, input(`@[${CLIENT}] please look`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectInvalidMention(result.error, []);
  });

  it('other proc errors carry no invalidMentions', async () => {
    const { client } = makeClient({
      activeIds: [],
      rpc: { data: null, error: { message: 'invalid_payload', details: 'x' } },
    });
    const result = await createComment(client, input('plain text'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ code: 'invalid_payload', message: 'invalid_payload' });
    expect(isInvalidMention(result.error)).toBe(false);
  });
});

describe('parseInvalidMentionDetail', () => {
  it('splits, trims, lowercases and de-duplicates the DETAIL ids', () => {
    expect(parseInvalidMentionDetail(` ${CLIENT} ,${CLIENT.toUpperCase()},${OUTSIDER}`)).toEqual([
      CLIENT,
      OUTSIDER,
    ]);
  });

  it('returns [] for no DETAIL or an empty one', () => {
    expect(parseInvalidMentionDetail(undefined)).toEqual([]);
    expect(parseInvalidMentionDetail('')).toEqual([]);
  });

  it('invalidMentionError builds the shared shape', () => {
    expect(invalidMentionError('m', [CLIENT])).toEqual({
      code: 'invalid_mention',
      message: 'm',
      invalidMentions: [CLIENT],
    });
  });
});
