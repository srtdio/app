import { describe, expect, it, vi } from 'vitest';
import { planSave, type Client, type PlanSaveOp } from './index';

describe('planSave', () => {
  const ops: PlanSaveOp[] = [
    { op: 'update', title: 'Week of 12 Oct', starts_on: '2026-10-12', ends_on: '2026-10-19' },
    {
      op: 'move',
      item_id: '11111111-1111-1111-1111-111111111111',
      target_date: '2026-10-14',
      item_ids: ['11111111-1111-1111-1111-111111111111'],
      keep_reviews: true,
    },
    { op: 'remove', item_id: '33333333-3333-3333-3333-333333333333' },
    { op: 'reorder', item_ids: ['11111111-1111-1111-1111-111111111111'] },
  ];
  const args = {
    p_plan_id: '44444444-4444-4444-4444-444444444444',
    p_ops: ops,
    p_trace_id: '22222222-2222-2222-2222-222222222222',
  };

  it('one call to plan_save with the ops in order and the trace id', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const result = await planSave({ rpc } as unknown as Client, args);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('plan_save', args);
    const sent = (rpc.mock.calls[0] as unknown[])[1] as { p_ops: PlanSaveOp[] };
    expect(sent.p_ops.map((o) => o.op)).toEqual(['update', 'move', 'remove', 'reorder']);
    // A No date move goes through as null (never the string "null").
    await planSave({ rpc } as unknown as Client, {
      ...args,
      p_ops: [{ op: 'move', item_id: 'i', target_date: null, item_ids: ['i'], keep_reviews: false }],
    });
    const second = (rpc.mock.calls[1] as unknown[])[1] as { p_ops: PlanSaveOp[] };
    expect(second.p_ops[0]).toMatchObject({ target_date: null, keep_reviews: false });
  });

  it('passes the inner procs’ errors through: forbidden_role, invalid_payload, date_outside_plan', async () => {
    for (const code of ['forbidden_role', 'invalid_payload'] as const) {
      const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: code } }));
      expect(await planSave({ rpc } as unknown as Client, args)).toEqual({
        ok: false,
        error: { code, message: code },
      });
    }
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: { message: 'date_outside_plan' } }));
    expect(await planSave({ rpc } as unknown as Client, args)).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'date_outside_plan' },
    });
  });
});
