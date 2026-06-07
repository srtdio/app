// Pure coverage of the stage machine: every (from, to) pair in the 5x5 matrix is
// asserted against STAGE_TRANSITIONS, plus the cases the locked map gets wrong
// most often (approved is NOT terminal: it may be parked or rejected, but it may
// not go back to draft or review).

import { describe, expect, it } from 'vitest';
import { STAGE_TRANSITIONS, canTransition, type Stage } from '../../packages/posts/src/index';

const STAGES: readonly Stage[] = ['draft', 'review', 'approved', 'parked', 'rejected'];

function allowed(from: Stage, to: Stage): boolean {
  return (STAGE_TRANSITIONS[from] as readonly Stage[]).includes(to);
}

describe('canTransition matrix', () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      const expected = allowed(from, to);
      it(`${from} -> ${to} is ${expected ? 'allowed' : 'disallowed'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }
});

describe('locked transition map', () => {
  it('matches the spec exactly', () => {
    expect(STAGE_TRANSITIONS).toEqual({
      draft: ['review', 'parked'],
      review: ['approved', 'rejected', 'parked'],
      approved: ['parked', 'rejected'],
      parked: ['review'],
      rejected: ['review'],
    });
  });

  it('treats approved as non-terminal: parked and rejected are allowed', () => {
    expect(canTransition('approved', 'parked')).toBe(true);
    expect(canTransition('approved', 'rejected')).toBe(true);
  });

  it('forbids approved going back to draft or review', () => {
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('approved', 'review')).toBe(false);
  });

  it('revives parked and rejected only to review', () => {
    expect(canTransition('parked', 'review')).toBe(true);
    expect(canTransition('rejected', 'review')).toBe(true);
    expect(canTransition('parked', 'approved')).toBe(false);
    expect(canTransition('rejected', 'draft')).toBe(false);
  });
});
