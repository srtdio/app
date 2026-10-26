import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { resolveRef } from '@/components/refs/useRefResolution';

// A fake client with only .rpc: every call is recorded and answered from the
// canned ref_resolve rows for its kind. No table reads exist to fake (a .from
// call would throw), so the request count is exactly the rpc calls.
interface Answer {
  data: unknown;
  error: { message: string } | null;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function fakeClient(answers: { post?: Answer; brief?: Answer }): {
  client: Client;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>): Promise<Answer> {
      calls.push({ fn, args });
      const kind = args.p_kind === 'brief' ? 'brief' : 'post';
      return Promise.resolve(answers[kind] ?? { data: [], error: null });
    },
  };
  return { client: client as unknown as Client, calls };
}

const TRACE = '01920000-0000-7000-8000-00000000000a';
const hit = (entity: string | null): Answer => ({
  data: [{ workspace_id: 'w1', entity_id: entity }],
  error: null,
});
const noWorkspace: Answer = { data: [], error: null };

describe('resolveRef', () => {
  it('resolves a /p ref in one ref_resolve call with the trace id', async () => {
    const { client, calls } = fakeClient({ post: hit('post-1') });
    const res = await resolveRef(client, 'gbl-5', 'post', TRACE);
    expect(res).toEqual({ status: 'resolved', id: 'post-1' });
    expect(calls).toEqual([
      {
        fn: 'ref_resolve',
        args: { p_trace_id: TRACE, p_workspace_key: 'GBL', p_kind: 'post', p_number: 5 },
      },
    ]);
  });

  it('resolves a /b ref to the brief id in one call', async () => {
    const { client, calls } = fakeClient({ brief: hit('brief-1') });
    const res = await resolveRef(client, 'GBL-5', 'brief', TRACE);
    expect(res).toEqual({ status: 'resolved', id: 'brief-1' });
    expect(calls).toHaveLength(1);
  });

  it('redirects a /p ref to /b when the number is a brief: one more call, same trace', async () => {
    const { client, calls } = fakeClient({ post: hit(null), brief: hit('brief-1') });
    const res = await resolveRef(client, 'gbl-5', 'post', TRACE);
    expect(res).toEqual({ status: 'redirect', to: '/b/gbl-5' });
    expect(calls.map((c) => c.args.p_kind)).toEqual(['post', 'brief']);
    expect(calls.every((c) => c.args.p_trace_id === TRACE)).toBe(true);
  });

  it('redirects a /b ref to /p when the number is a post', async () => {
    const { client } = fakeClient({ brief: hit(null), post: hit('post-1') });
    const res = await resolveRef(client, 'gbl-5', 'brief', TRACE);
    expect(res).toEqual({ status: 'redirect', to: '/p/gbl-5' });
  });

  it('is not-found for an unparseable ref (no calls)', async () => {
    const { client, calls } = fakeClient({});
    expect(await resolveRef(client, 'nonsense', 'post')).toEqual({ status: 'notfound' });
    expect(await resolveRef(client, undefined, 'brief')).toEqual({ status: 'notfound' });
    expect(calls).toEqual([]);
  });

  it('is not-found in one call when the key is unknown or hidden by RLS (no probe)', async () => {
    const { client, calls } = fakeClient({ post: noWorkspace, brief: hit('brief-1') });
    expect(await resolveRef(client, 'GBL-5', 'post', TRACE)).toEqual({ status: 'notfound' });
    expect(calls).toHaveLength(1);
  });

  it('is not-found when neither a post nor a brief carries the number', async () => {
    const { client, calls } = fakeClient({ post: hit(null), brief: hit(null) });
    expect(await resolveRef(client, 'GBL-5', 'post', TRACE)).toEqual({ status: 'notfound' });
    expect(calls).toHaveLength(2);
  });

  it('is not-found on a transport error, with no probe', async () => {
    const { client, calls } = fakeClient({
      post: { data: null, error: { message: 'boom' } },
      brief: hit('brief-1'),
    });
    expect(await resolveRef(client, 'GBL-5', 'post', TRACE)).toEqual({ status: 'notfound' });
    expect(calls).toHaveLength(1);
  });

  it('mints a uuid v7 trace id when none is passed', async () => {
    const { client, calls } = fakeClient({ post: hit('post-1') });
    await resolveRef(client, 'gbl-5', 'post');
    expect(String(calls[0]?.args.p_trace_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
