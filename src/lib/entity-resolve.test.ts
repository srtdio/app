import { describe, expect, it, vi } from 'vitest';
import { mapResolvedRef, resolveEntityRef } from '@/lib/entity-resolve';

type Client = Parameters<typeof resolveEntityRef>[0];

const TRACE = '01920000-0000-7000-8000-000000000002';

// A PostgREST-like builder: setHeader and abortSignal return the same builder,
// and awaiting it resolves the answer. rpc() returns it, so the X-Trace-Id the
// call stamps is observable beside the p_trace_id it sends.
function headerClient(answer: { data: unknown; error: null }) {
  const setHeader = vi.fn<(name: string, value: string) => unknown>();
  const abortSignal = vi.fn<(signal: AbortSignal) => unknown>();
  const builder = {
    setHeader,
    abortSignal,
    then: (resolve: (value: typeof answer) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject),
  };
  setHeader.mockReturnValue(builder);
  abortSignal.mockReturnValue(builder);
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => typeof builder>(() => builder);
  return { client: { rpc } as unknown as Client, rpc, setHeader, abortSignal };
}

function rpcClient(answer: { data: unknown; error: { message: string } | null }): {
  client: Client;
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn(() => Promise.resolve(answer));
  const from = vi.fn();
  return { client: { rpc, from } as unknown as Client, rpc, from };
}

describe('mapResolvedRef', () => {
  it('maps the row to the workspace and entity ids', () => {
    expect(mapResolvedRef([{ workspace_id: 'w1', entity_id: 'p1' }])).toEqual({
      workspaceId: 'w1',
      entityId: 'p1',
    });
  });

  it('a workspace with no such entity keeps the workspace and a null entity', () => {
    expect(mapResolvedRef([{ workspace_id: 'w1', entity_id: null }])).toEqual({
      workspaceId: 'w1',
      entityId: null,
    });
  });

  it('no row (absent or hidden key) is unresolved', () => {
    expect(mapResolvedRef([])).toEqual({ workspaceId: null, entityId: null });
    expect(mapResolvedRef(null)).toEqual({ workspaceId: null, entityId: null });
  });
});

describe('resolveEntityRef', () => {
  const params = { traceId: TRACE, workspaceKey: 'GBL', kind: 'post' as const, number: 12 };

  it('stamps X-Trace-Id with the exact p_trace_id it sends', async () => {
    const { client, rpc, setHeader } = headerClient({
      data: [{ workspace_id: 'w1', entity_id: 'p1' }],
      error: null,
    });
    const res = await resolveEntityRef(client, params);
    expect(res).toEqual({ ok: true, data: { workspaceId: 'w1', entityId: 'p1' } });
    expect(rpc.mock.calls[0]?.[0]).toBe('ref_resolve');
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(traceId).toBe(TRACE);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
  });

  it('is one ref_resolve rpc with the explicit trace id and no table reads', async () => {
    const { client, rpc, from } = rpcClient({
      data: [{ workspace_id: 'w1', entity_id: 'p1' }],
      error: null,
    });
    const res = await resolveEntityRef(client, params);
    expect(res).toEqual({ ok: true, data: { workspaceId: 'w1', entityId: 'p1' } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ref_resolve', {
      p_trace_id: TRACE,
      p_workspace_key: 'GBL',
      p_kind: 'post',
      p_number: 12,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('passes the brief kind through', async () => {
    const { client, rpc } = rpcClient({ data: [], error: null });
    await resolveEntityRef(client, { ...params, kind: 'brief' });
    expect(rpc).toHaveBeenCalledWith('ref_resolve', expect.objectContaining({ p_kind: 'brief' }));
  });

  it('no row is an ok, unresolved result (never null)', async () => {
    const { client } = rpcClient({ data: [], error: null });
    const res = await resolveEntityRef(client, params);
    expect(res).toEqual({ ok: true, data: { workspaceId: null, entityId: null } });
  });

  it('an rpc error is a failed Result', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'boom' } });
    const res = await resolveEntityRef(client, params);
    expect(res.ok).toBe(false);
  });

  it('a rejected transport is a failed Result, never a throw', async () => {
    const rpc = vi.fn(() => Promise.reject(new Error('down')));
    const res = await resolveEntityRef({ rpc } as unknown as Client, params);
    expect(res.ok).toBe(false);
  });
});
