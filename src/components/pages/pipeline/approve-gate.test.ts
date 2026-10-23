import { describe, expect, it, vi } from 'vitest';
import type { Stage } from '@srtdio/posts';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
  type MoveOptions,
} from '@/components/pages/pipeline/approve-gate';

type Move = (postId: string, toStage: Stage, options?: MoveOptions) => void;

function harness(): {
  gate: ReturnType<typeof createApproveGate>;
  move: ReturnType<typeof vi.fn<Move>>;
  state: () => GateState;
} {
  let state = GATE_IDLE;
  const move = vi.fn<Move>();
  const gate = createApproveGate({
    move,
    read: () => state,
    write: (next) => {
      state = next;
    },
  });
  return { gate, move, state: () => state };
}

describe('approve gate', () => {
  it('T1: an approve request parks the post and does not move', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    expect(h.move).not.toHaveBeenCalled();
    expect(h.state()).toEqual({ pendingId: 'p1', sent: false });
  });

  it('T2: cancel forgets the pending approve and a later confirm sends nothing', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    h.gate.cancel();
    h.gate.confirm();
    expect(h.move).not.toHaveBeenCalled();
    expect(h.state()).toEqual(GATE_IDLE);
  });

  it('T3: confirm moves once with the original args', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    h.gate.confirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T4: a double tap moves once; settle re-arms a single retry', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    h.gate.confirm();
    h.gate.confirm();
    expect(h.move).toHaveBeenCalledOnce();
    h.gate.settle();
    h.gate.confirm();
    h.gate.confirm();
    expect(h.move).toHaveBeenCalledTimes(2);
  });

  it('T5: every other target moves at once and opens no confirm', () => {
    for (const stage of ['review', 'parked', 'rejected'] as const) {
      const h = harness();
      h.gate.request('p1', stage);
      expect(h.move).toHaveBeenCalledWith('p1', stage);
      expect(h.state()).toEqual(GATE_IDLE);
    }
  });

  it('T6: an on-behalf confirm carries the picked approver into the move', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    h.gate.confirm('u-client');
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved', { onBehalfOf: 'u-client' });
  });

  it('T7: a click event or an empty id passed to confirm reads as no approver', () => {
    for (const arg of [{ type: 'click' }, '', undefined]) {
      const h = harness();
      h.gate.request('p1', 'approved');
      h.gate.confirm(arg);
      expect(h.move).toHaveBeenCalledWith('p1', 'approved');
      expect(h.move.mock.calls[0]).toHaveLength(2);
    }
  });
});
