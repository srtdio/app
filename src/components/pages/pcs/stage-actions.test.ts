import { describe, expect, it } from 'vitest';
import {
  canRoleMove,
  roleMayTarget,
  STAGE_REASON_LABEL,
  stageReasonComment,
  stageReasonConfirm,
  visibleStageActions,
} from '@/components/pages/pcs/stage-actions';
import { STAGE_TRANSITIONS, canTransition } from '@srtdio/posts';
import type { Stage } from '@srtdio/posts';

// The visibility matrix matches the server (stage_transition) exactly: the
// client only sees approve / reject, the agency side sees approve / reject (on
// the client's behalf) plus park / move-to-review, and an unknown role sees
// nothing.

function labels(stage: Stage, role: string | null): string[] {
  return visibleStageActions(stage, role).map((a) => a.label);
}

describe('visibleStageActions', () => {
  it('shows the client approve + reject at review, reject at approved', () => {
    expect(labels('review', 'client')).toEqual(['Approve', 'Reject']);
    expect(labels('approved', 'client')).toEqual(['Reject']);
  });

  it('styles the client reject action as danger', () => {
    expect(visibleStageActions('review', 'client')).toContainEqual({
      to: 'rejected',
      label: 'Reject',
      variant: 'danger',
    });
    expect(visibleStageActions('approved', 'client')).toContainEqual({
      to: 'rejected',
      label: 'Reject',
      variant: 'danger',
    });
  });

  it('gives the client nothing to do in draft / parked / rejected', () => {
    expect(labels('draft', 'client')).toEqual([]);
    expect(labels('parked', 'client')).toEqual([]);
    expect(labels('rejected', 'client')).toEqual([]);
  });

  it('shows the agency side send-for-review + park from draft', () => {
    expect(labels('draft', 'agency')).toEqual(['Send for review', 'Park']);
  });

  it('shows the agency side approve, reject and park at review; park and reject at approved', () => {
    for (const role of ['owner', 'admin', 'agency']) {
      expect(labels('review', role)).toEqual(['Approve', 'Reject', 'Park']);
      expect(labels('approved', role)).toEqual(['Park', 'Reject']);
    }
  });

  it('shows the agency side send-for-review from parked and rejected (E10)', () => {
    expect(labels('parked', 'agency')).toEqual(['Send for review']);
    expect(labels('rejected', 'agency')).toEqual(['Send for review']);
  });

  it('treats every agency-side role the same', () => {
    for (const role of ['owner', 'admin', 'agency']) {
      expect(labels('draft', role)).toEqual(['Send for review', 'Park']);
    }
  });

  it('shows nothing for a null role (no membership: fully read-only)', () => {
    expect(labels('review', null)).toEqual([]);
    expect(labels('draft', null)).toEqual([]);
    expect(labels('approved', null)).toEqual([]);
  });
});

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

describe('canRoleMove (pipeline targets per role)', () => {
  function targets(role: string | null, from: Stage): Stage[] {
    return STAGES.filter((to) => canRoleMove(role, from, to));
  }

  it('client: only approved and rejected, where the map allows', () => {
    expect(targets('client', 'review')).toEqual(['approved', 'rejected']);
    expect(targets('client', 'approved')).toEqual(['rejected']);
    expect(targets('client', 'draft')).toEqual([]);
    expect(targets('client', 'parked')).toEqual([]);
    expect(targets('client', 'rejected')).toEqual([]);
  });

  it('client never gets Park or Back to review', () => {
    for (const from of STAGES) {
      expect(canRoleMove('client', from, 'parked')).toBe(false);
      expect(canRoleMove('client', from, 'review')).toBe(false);
    }
  });

  it('agency, admin, owner: every legal target', () => {
    for (const role of ['agency', 'admin', 'owner']) {
      for (const from of STAGES) {
        expect(targets(role, from)).toEqual(STAGES.filter((to) => canTransition(from, to)));
      }
    }
  });

  it('unknown role: nothing', () => {
    for (const from of STAGES) expect(targets(null, from)).toEqual([]);
  });

  it('roleMayTarget never allows draft', () => {
    expect(roleMayTarget('owner', 'draft')).toBe(false);
  });
});

describe('stageReasonConfirm (W2 reject / park confirm)', () => {
  it('reject and park ask first with their own copy; approve and review keep their paths', () => {
    expect(stageReasonConfirm('rejected')).toEqual({
      title: 'Reject this post?',
      confirmLabel: 'Reject',
      undoLabel: 'Post rejected',
    });
    expect(stageReasonConfirm('parked')).toEqual({
      title: 'Park this post?',
      confirmLabel: 'Park',
      undoLabel: 'Post parked',
    });
    expect(stageReasonConfirm('approved')).toBeNull();
    expect(stageReasonConfirm('review')).toBeNull();
    expect(STAGE_REASON_LABEL).toBe('Reason (optional), goes to the comments');
  });

  it('a blank reason posts no comment; a typed one is trimmed', () => {
    expect(stageReasonComment('   ')).toBeNull();
    expect(stageReasonComment('  Wrong offer  ')).toBe('Wrong offer');
  });

  it('the stage map is unchanged: approved can still be parked or rejected', () => {
    expect(canTransition('approved', 'parked')).toBe(true);
    expect(canTransition('approved', 'rejected')).toBe(true);
  });
});
