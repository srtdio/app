import { describe, expect, it, vi } from 'vitest';
import {
  assetDelete,
  assetDeleteMany,
  briefReopen,
  memberRemove,
  planDraftRows,
  planItemMove,
  planPostsAdd,
  postSoftDelete,
  TRACE_HEADER,
  userProfileUpdate,
  withTraceHeader,
  type Client,
} from './index';

// A minimal client whose rpc() returns the configured PostgREST shape and
// records how it was called. assetDelete must forward the proc name and the
// args object (carrying p_trace_id) unchanged, and adapt { data, error } into a
// Result, mirroring the other @srtdio/rpc wrappers.
function makeClient(result: {
  data: unknown;
  error: { message: string; details?: string | null } | null;
}) {
  const rpc = vi.fn(() => Promise.resolve(result));
  const client = { rpc } as unknown as Client;
  return { client, rpc };
}

describe('assetDelete', () => {
  const args = {
    p_asset_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await assetDelete(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('asset_delete', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps the workspace_member_only exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await assetDelete(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('briefReopen', () => {
  const args = {
    p_brief_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args (with p_trace_id) unchanged', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await briefReopen(client, args);
    expect(result).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('brief_reopen', args);
  });

  it('maps the invalid_payload exception (not closed, or missing) to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await briefReopen(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps the workspace_member_only exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await briefReopen(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await briefReopen(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('assetDeleteMany', () => {
  const args = {
    p_asset_ids: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
    p_trace_id: '33333333-3333-3333-3333-333333333333',
  };

  it('returns ok and forwards the proc name + args unchanged on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await assetDeleteMany(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('asset_delete_many', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await assetDeleteMany(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await assetDeleteMany(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('postSoftDelete', () => {
  const args = {
    p_post_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await postSoftDelete(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('post_soft_delete', args);
  });

  it('maps the forbidden_role exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await postSoftDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await postSoftDelete(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('memberRemove', () => {
  const args = {
    p_member_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({
      data: '11111111-1111-1111-1111-111111111111',
      error: null,
    });
    const result = await memberRemove(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('member_remove', args);
  });

  it('maps the forbidden_role exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'forbidden_role' } });
    const result = await memberRemove(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });

  it('maps the workspace_member_only exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'workspace_member_only' } });
    const result = await memberRemove(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'workspace_member_only', message: 'workspace_member_only' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await memberRemove(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('userProfileUpdate', () => {
  const args = {
    p_display_name: 'Asha Rao',
    // designation is optional in the proc (coalesce); the generated arg type is
    // non-nullable, so cast null the same way the proc suite does.
    p_designation: null as unknown as string,
    p_avatar_url: 'https://x/a.png',
    p_email_opt_in: true,
    p_trace_id: '33333333-3333-3333-3333-333333333333',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({
      data: '44444444-4444-4444-4444-444444444444',
      error: null,
    });
    const result = await userProfileUpdate(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('user_profile_update', args);
  });

  it('maps the invalid_payload exception to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await userProfileUpdate(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });
});

describe('planDraftRows', () => {
  const args = {
    p_plan_ids: ['11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444'],
  };
  const rows = [
    {
      plan_id: '11111111-1111-1111-1111-111111111111',
      item_id: '33333333-3333-3333-3333-333333333333',
      item_position: 0,
      post_number: 7,
      title: 'Launch teaser',
      target_date: '2026-10-20T00:00:00+00:00',
    },
  ];

  it('returns ok with the rows and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: rows, error: null });
    const result = await planDraftRows(client, args);
    expect(result).toEqual({ ok: true, data: rows });
    expect(rpc).toHaveBeenCalledWith('plan_draft_rows', args);
  });

  it('maps the invalid_payload exception (over 100 ids) to a domain error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'invalid_payload' } });
    const result = await planDraftRows(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });

  it('maps an unexpected transport error to code "unknown"', async () => {
    const { client } = makeClient({ data: null, error: { message: 'network down' } });
    const result = await planDraftRows(client, args);
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'network down' } });
  });
});

describe('planItemMove', () => {
  const args = {
    p_item_id: '11111111-1111-1111-1111-111111111111',
    p_target_date: '2026-10-14',
    p_item_ids: ['11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333'],
    p_keep_reviews: false,
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('returns ok and forwards the proc name + args on success', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    const result = await planItemMove(client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('plan_item_move', args);
  });

  it('always sends the 5-arg overload: p_keep_reviews goes through as given', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    await planItemMove(client, { ...args, p_keep_reviews: true });
    expect(rpc).toHaveBeenCalledWith('plan_item_move', { ...args, p_keep_reviews: true });
    expect(Object.keys((rpc.mock.calls[0] as unknown[])[1] as object).sort()).toEqual([
      'p_item_id',
      'p_item_ids',
      'p_keep_reviews',
      'p_target_date',
      'p_trace_id',
    ]);
  });

  it('passes a null date (No date) through unchanged', async () => {
    const { client, rpc } = makeClient({ data: null, error: null });
    await planItemMove(client, { ...args, p_target_date: null });
    expect(rpc).toHaveBeenCalledWith('plan_item_move', { ...args, p_target_date: null });
  });

  it('maps forbidden_role and invalid_payload; keeps date_outside_plan as the message', async () => {
    for (const code of ['forbidden_role', 'invalid_payload'] as const) {
      const { client } = makeClient({ data: null, error: { message: code } });
      expect(await planItemMove(client, args)).toEqual({
        ok: false,
        error: { code, message: code },
      });
    }
    const { client } = makeClient({ data: null, error: { message: 'date_outside_plan' } });
    expect(await planItemMove(client, args)).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'date_outside_plan' },
    });
  });
});

describe('planPostsAdd', () => {
  const base = {
    p_plan_id: '11111111-1111-1111-1111-111111111111',
    p_post_ids: ['33333333-3333-3333-3333-333333333333'],
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('without p_target_date: the 3-arg shape still compiles and is forwarded as is', async () => {
    const { client, rpc } = makeClient({ data: 1, error: null });
    const result = await planPostsAdd(client, base);
    expect(result).toEqual({ ok: true, data: 1 });
    expect(rpc).toHaveBeenCalledWith('plan_posts_add', base);
  });

  it('with p_target_date: forwarded with the day', async () => {
    const { client, rpc } = makeClient({ data: 1, error: null });
    await planPostsAdd(client, { ...base, p_target_date: '2026-10-14' });
    expect(rpc).toHaveBeenCalledWith('plan_posts_add', { ...base, p_target_date: '2026-10-14' });
  });
});

describe('invalid_mention', () => {
  const args = {
    p_asset_id: '11111111-1111-1111-1111-111111111111',
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('maps invalid_mention to a domain error and keeps the DETAIL ids', async () => {
    const { client } = makeClient({
      data: null,
      error: { message: 'invalid_mention', details: 'a,b' },
    });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_mention', message: 'invalid_mention', details: 'a,b' },
    });
  });

  it('omits details when the proc raised none', async () => {
    const { client } = makeClient({
      data: null,
      error: { message: 'invalid_mention', details: null },
    });
    const result = await assetDelete(client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_mention', message: 'invalid_mention' },
    });
  });
});

describe('withTraceHeader', () => {
  const TRACE = '0192a000-0000-7000-8000-000000000001';

  it('names the header X-Trace-Id', () => {
    expect(TRACE_HEADER).toBe('X-Trace-Id');
  });

  it("stamps the builder's X-Trace-Id with the trace id and returns setHeader's result", () => {
    const stamped = { stamped: true };
    const setHeader = vi.fn<(name: string, value: string) => typeof stamped>(() => stamped);
    const builder = { setHeader };
    const out = withTraceHeader(builder, TRACE);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', TRACE);
    expect(out).toBe(stamped);
  });

  it('passes a builder without setHeader through unchanged', () => {
    const builder = { then: vi.fn() };
    expect(withTraceHeader(builder, TRACE)).toBe(builder);
    const promise = Promise.resolve({ data: null, error: null });
    expect(withTraceHeader(promise, TRACE)).toBe(promise);
  });

  it('passes through a builder whose setHeader is not a function', () => {
    const builder = { setHeader: 'nope' };
    expect(withTraceHeader(builder, TRACE)).toBe(builder);
  });
});
