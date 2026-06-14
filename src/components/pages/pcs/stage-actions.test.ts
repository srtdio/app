import { describe, expect, it } from 'vitest';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';
import type { Stage } from '@srtdio/posts';

// The visibility matrix matches the server (stage_transition) exactly: the
// client only sees approve / request-changes, the agency side only sees
// park / move-to-review, and an unknown role sees nothing.

function labels(stage: Stage, role: string | null): string[] {
  return visibleStageActions(stage, role).map((a) => a.label);
}

describe('visibleStageActions', () => {
  it('shows the client approve + request changes at review, request changes at approved', () => {
    expect(labels('review', 'client')).toEqual(['Approve', 'Request changes']);
    expect(labels('approved', 'client')).toEqual(['Request changes']);
  });

  it('gives the client nothing to do in draft / parked / rejected', () => {
    expect(labels('draft', 'client')).toEqual([]);
    expect(labels('parked', 'client')).toEqual([]);
    expect(labels('rejected', 'client')).toEqual([]);
  });

  it('shows the agency side send-for-review + park from draft', () => {
    expect(labels('draft', 'agency')).toEqual(['Send for review', 'Park']);
  });

  it('shows the agency side only park at review and at approved', () => {
    expect(labels('review', 'admin')).toEqual(['Park']);
    expect(labels('approved', 'owner')).toEqual(['Park']);
  });

  it('shows the agency side move-to-review from parked and rejected', () => {
    expect(labels('parked', 'agency')).toEqual(['Move to review']);
    expect(labels('rejected', 'agency')).toEqual(['Move to review']);
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
