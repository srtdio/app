import { describe, expect, it, vi } from 'vitest';
import { PLAN_FIRE_LIMIT, createPlanFireOnce } from '@/lib/chat/plan-fire';
import { createPlanCardCache, type PlanBundle } from '@/lib/chat/plans';
import type { Result } from '@srtdio/rpc';

describe('plan cards fire once per open', () => {
  it('holds every ask until the chat bundle returns, then fires its ids and the held ones', () => {
    const fire = vi.fn();
    const gate = createPlanFireOnce(fire);
    gate.request(['p-card']);
    gate.request(['p-ticker', 'p-card']);
    expect(fire).not.toHaveBeenCalled();
    expect(gate.openedBy()).toBeNull();
    gate.bundleReturned(['p-shared', 'p-card']);
    expect(gate.openedBy()).toBe('bundle');
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[0]).toEqual(['p-shared', 'p-card', 'p-ticker']);
  });

  it('a tap before the bundle fires first; the bundle then adds only ids never fired', () => {
    const fire = vi.fn();
    const gate = createPlanFireOnce(fire);
    gate.request(['p1']);
    gate.tapped(['p1']);
    expect(gate.openedBy()).toBe('tap');
    expect(fire.mock.calls).toEqual([[['p1']]]);
    gate.bundleReturned(['p1', 'p2']);
    expect(fire.mock.calls).toEqual([[['p1']], [['p2']]]);
    expect(gate.openedBy()).toBe('tap');
  });

  it('the bundle first: a tap later never fires the same ids again', () => {
    const fire = vi.fn();
    const gate = createPlanFireOnce(fire);
    gate.bundleReturned(['p1']);
    gate.tapped(['p1']);
    gate.request(['p1']);
    gate.bundleReturned(['p1']);
    expect(fire.mock.calls).toEqual([[['p1']]]);
    // A new id (a live share, an older page) goes at once.
    gate.request(['p3']);
    expect(fire.mock.calls).toEqual([[['p1']], [['p3']]]);
    expect(gate.fired()).toEqual(['p1', 'p3']);
  });

  it('carries at most 200 ids per fire; the rest go in the next at once', () => {
    const fire = vi.fn();
    const gate = createPlanFireOnce(fire);
    const ids = Array.from({ length: PLAN_FIRE_LIMIT + 5 }, (_, i) => `p${i}`);
    gate.bundleReturned(ids);
    expect(fire).toHaveBeenCalledTimes(2);
    expect((fire.mock.calls[0]?.[0] as string[]).length).toBe(200);
    expect((fire.mock.calls[1]?.[0] as string[]).length).toBe(5);
  });

  it('a failed bundle opens the gate with what the cards asked (cards never wait forever)', () => {
    const fire = vi.fn();
    const gate = createPlanFireOnce(fire);
    gate.request(['p1']);
    gate.bundleReturned([]);
    expect(fire.mock.calls).toEqual([[['p1']]]);
  });
});

describe('no stale plan bundle is ever painted', () => {
  const bundle = (id: string, title: string): PlanBundle =>
    ({ plan: { id, title }, items: [] }) as unknown as PlanBundle;

  it('a new open is a new cache: loading until its own read lands, never the old title', async () => {
    let title = 'Old title';
    const read = vi.fn(
      async (ids: string[]): Promise<Result<Map<string, PlanBundle>>> => ({
        ok: true,
        data: new Map(ids.map((id) => [id, bundle(id, title)])),
      }),
    );
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // The first open: its read lands, the card shows the old title.
    const first = createPlanCardCache(read);
    const firstGate = createPlanFireOnce((ids) => first.request(ids));
    firstGate.request(['p1']);
    firstGate.bundleReturned([]);
    await flush();
    expect(first.snapshot(['p1']).bundles.get('p1')?.plan.title).toBe('Old title');
    first.dispose();
    // The plan changes while closed; the reopen makes its own cache and gate.
    title = 'New title';
    const second = createPlanCardCache(read);
    const gate = createPlanFireOnce((ids) => second.request(ids));
    gate.request(['p1']);
    await flush();
    // Waiting for the chat bundle: loading (the card's skeleton), no bundle at all.
    expect(second.snapshot(['p1']).loading).toBe(true);
    expect(second.snapshot(['p1']).bundles.size).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    gate.bundleReturned(['p1']);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(second.snapshot(['p1']).bundles.get('p1')?.plan.title).toBe('New title');
  });
});
