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
    p_trace_id: 't',
  };

  it('one call to the proc with the args unchanged; returns the plan id', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'plan-1', error: null }));
    const result = await planCreateWithItems({ rpc } as unknown as Client, args);
    expect(result).toEqual({ ok: true, data: 'plan-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('plan_create_with_items', args);
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
