import { describe, expect, it, vi } from 'vitest';
import { planCreateWithItems, type Client } from './index';

describe('planCreateWithItems', () => {
  const args = {
    p_workspace_id: 'ws',
    p_title: 'Week',
    p_starts_on: '2026-10-12',
    p_ends_on: '2026-10-18',
    p_concepts: [{ title: 'C', description: '', attachment_version_ids: [], target_date: null }],
    p_posts: [{ post_id: 'p1', target_date: '2026-10-14' }],
    p_bank: [
      { item_id: 'b1', target_date: null },
      { item_id: 'b2', target_date: '2026-10-15' },
    ],
    p_trace_id: 't',
  };

  it('one call to the proc with the args unchanged; returns the plan id', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'plan-1', error: null }));
    const result = await planCreateWithItems({ rpc } as unknown as Client, args);
    expect(result).toEqual({ ok: true, data: 'plan-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('plan_create_with_items', args);
  });

  it('sends p_bank so PostgREST resolves the 8-arg overload', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'plan-1', error: null }));
    await planCreateWithItems({ rpc } as unknown as Client, { ...args, p_bank: [] });
    const sent = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(sent).toHaveProperty('p_bank', []);
    expect(Object.keys(sent).sort()).toEqual(
      [
        'p_bank',
        'p_concepts',
        'p_ends_on',
        'p_posts',
        'p_starts_on',
        'p_title',
        'p_trace_id',
        'p_workspace_id',
      ].sort(),
    );
  });

  it('maps a domain error', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: 'invalid_payload' } }));
    const result = await planCreateWithItems({ rpc } as unknown as Client, args);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
  });
});
