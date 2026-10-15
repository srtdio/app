import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import {
  POST_CHANGED_EVENT,
  REFETCH_AFTER_MS,
  approverIds,
  approverLabel,
  cardFooter,
  eventTouchesBatch,
  firstName,
  indexPostsById,
  mediaPills,
  postRoute,
  sharedPostViews,
  staleOnVisible,
  watchBatchFreshness,
} from '@/components/chat/post-card';

const TZ = 'UTC';

/** Pin the device locale: Intl.DateTimeFormat with no locale resolves to `locale`. */
function deviceLocale(locale: string): void {
  const Real = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    requested?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new Real(requested ?? locale, options);
  } as typeof Intl.DateTimeFormat);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function cardRow(id: string, over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id,
    number: 7,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'carousel',
    stage: 'approved',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

describe('postRoute', () => {
  it('points at the existing /posts/:id view', () => {
    expect(postRoute('p1')).toBe('/posts/p1');
  });
});

describe('sharedPostViews', () => {
  it('renders one card per id, preserving message order (not the read order)', () => {
    const byId = indexPostsById([cardRow('p2'), cardRow('p1')]);
    const views = sharedPostViews(['p1', 'p2'], byId);
    expect(views.map((v) => v.postId)).toEqual(['p1', 'p2']);
    expect(views.every((v) => v.kind === 'post')).toBe(true);
  });

  it('maps an id the batched resolve did not return to the not-visible view', () => {
    const views = sharedPostViews(['p1', 'p2'], indexPostsById([cardRow('p1')]));
    expect(views[0]).toMatchObject({ kind: 'post', postId: 'p1' });
    expect(views[1]).toEqual({ kind: 'not_visible', postId: 'p2' });
  });

  it('maps every id to not-visible when the resolve returned nothing', () => {
    const views = sharedPostViews(['p1', 'p2'], new Map());
    expect(views.every((v) => v.kind === 'not_visible')).toBe(true);
  });

  it('carries the approver first name from the batched name map', () => {
    const byId = indexPostsById([
      cardRow('p1', { approved_by: 'u1' }),
      cardRow('p2', { approved_by: 'u9' }),
    ]);
    const views = sharedPostViews(['p1', 'p2'], byId, new Map([['u1', 'Asha Rao']]));
    expect(views[0]).toMatchObject({ approverName: 'Asha' });
    expect(views[1]).toMatchObject({ approverName: null });
  });
});

describe('approverIds / firstName', () => {
  it('dedupes approvers and drops nulls (one name lookup per batch)', () => {
    const ids = approverIds([
      cardRow('p1', { approved_by: 'u1' }),
      cardRow('p2', { approved_by: 'u1' }),
      cardRow('p3'),
    ]);
    expect(ids).toEqual(['u1']);
  });

  it('takes the first word of a display name', () => {
    expect(firstName('  Asha   Rao ')).toBe('Asha');
    expect(firstName('')).toBe('');
  });
});

describe('cardFooter', () => {
  const approved = cardRow('p1', { approved_by: 'u1', approved_at: '2026-09-21T14:05:00Z' });

  it('approved with a name: check, name and date + time, Open', () => {
    deviceLocale('en-GB');
    expect(cardFooter(approved, 'Asha', 'agency', TZ)).toEqual({
      state: 'Approved by Asha · Sep 21 14:05',
      action: 'Open',
      accent: false,
      check: true,
    });
  });

  it('the approval time follows the device hour cycle: en-IN 12h, en-GB 24h', () => {
    deviceLocale('en-IN');
    expect(cardFooter(approved, 'Asha', 'agency', TZ).state).toBe(
      'Approved by Asha · Sep 21 2:05 pm',
    );
    vi.restoreAllMocks();
    deviceLocale('en-GB');
    expect(cardFooter(approved, 'Asha', 'agency', TZ).state).toBe(
      'Approved by Asha · Sep 21 14:05',
    );
  });

  it('approved without an approver falls back to the stage_entered_at date', () => {
    expect(cardFooter(cardRow('p1'), null, 'client', TZ)).toMatchObject({
      state: 'Approved · Sep 20',
      action: 'Open',
      check: true,
    });
  });

  it('review words by side: client is waited on, agency waits, unknown is neutral', () => {
    const review = cardRow('p1', { stage: 'review' });
    expect(cardFooter(review, null, 'client', TZ)).toEqual({
      state: 'Waiting on you',
      action: 'Review',
      accent: true,
      check: false,
    });
    expect(cardFooter(review, null, 'agency', TZ)).toMatchObject({
      state: 'Waiting on approvers',
      action: 'Open',
      accent: false,
    });
    expect(cardFooter(review, null, 'unknown', TZ)).toMatchObject({
      state: 'In review',
      action: 'Open',
    });
  });

  it('draft, parked and rejected are their label with Open', () => {
    for (const [stage, label] of [
      ['draft', 'Draft'],
      ['parked', 'Parked'],
      ['rejected', 'Rejected'],
    ] as const) {
      expect(cardFooter(cardRow('p1', { stage }), null, 'client', TZ)).toEqual({
        state: label,
        action: 'Open',
        accent: false,
        check: false,
      });
    }
  });
});

describe('mediaPills', () => {
  it('shows slides past one item and a video label by format', () => {
    expect(mediaPills(cardRow('p', { mediaCount: 1 }))).toEqual({ slides: null, video: null });
    expect(mediaPills(cardRow('p', { mediaCount: 4 })).slides).toBe('4 slides');
    expect(mediaPills(cardRow('p', { hasVideo: true, format: 'video' })).video).toBe('Reel');
    expect(mediaPills(cardRow('p', { hasVideo: true, format: 'carousel' })).video).toBe('Video');
  });
});

describe('freshness', () => {
  it('is stale on return only after more than 60 s', () => {
    expect(REFETCH_AFTER_MS).toBe(60_000);
    expect(staleOnVisible(0, 60_000)).toBe(false);
    expect(staleOnVisible(0, 60_001)).toBe(true);
  });

  it('matches a post-changed event only for a post in the batch', () => {
    expect(eventTouchesBatch({ postId: 'p1' }, ['p1', 'p2'])).toBe(true);
    expect(eventTouchesBatch({ postId: 'p9' }, ['p1'])).toBe(false);
    expect(eventTouchesBatch(null, ['p1'])).toBe(false);
    expect(eventTouchesBatch({ postId: 1 }, ['p1'])).toBe(false);
  });

  function targets() {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    return { window: win, document: doc };
  }

  it('refetches on a post-changed event for the batch, not for others', () => {
    const t = targets();
    const refetch = vi.fn();
    const stop = watchBatchFreshness(t, {
      ids: () => ['p1'],
      fetchedAt: () => 0,
      now: () => 1,
      refetch,
    });
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p9' } }));
    expect(refetch).not.toHaveBeenCalled();
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    expect(refetch).toHaveBeenCalledTimes(1);
    stop();
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches on visible only when the batch is older than 60 s', () => {
    const t = targets();
    const refetch = vi.fn();
    let now = 30_000;
    watchBatchFreshness(t, { ids: () => ['p1'], fetchedAt: () => 0, now: () => now, refetch });
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).not.toHaveBeenCalled();
    now = 61_000;
    t.document.visibilityState = 'hidden';
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).not.toHaveBeenCalled();
    t.document.visibilityState = 'visible';
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('approver label (on behalf of the approvers)', () => {
  it('an agency-side approver reads "<name> on behalf of the approvers"', () => {
    for (const role of ['agency', 'admin', 'owner']) {
      expect(approverLabel('Chitra', role)).toBe('Chitra on behalf of the approvers');
    }
  });

  it('a client approver, an old row with no role, or a failed role read: name only', () => {
    expect(approverLabel('Asha', 'client')).toBe('Asha');
    expect(approverLabel('Asha', null)).toBe('Asha');
    expect(approverLabel('Asha', undefined)).toBe('Asha');
    expect(approverLabel(null, 'agency')).toBeNull();
  });

  it('sharedPostViews carries each approver role from the same batch', () => {
    const byId = indexPostsById([
      cardRow('p1', { approved_by: 'u1' }),
      cardRow('p2', { approved_by: 'u2' }),
    ]);
    const views = sharedPostViews(
      ['p1', 'p2'],
      byId,
      new Map([
        ['u1', 'Chitra Iyer'],
        ['u2', 'Asha Rao'],
      ]),
      new Map([['u1', 'agency']]),
    );
    expect(views[0]).toMatchObject({ approverName: 'Chitra', approverRole: 'agency' });
    expect(views[1]).toMatchObject({ approverName: 'Asha', approverRole: null });
  });

  it('the card footer prints the suffixed approver', () => {
    deviceLocale('en-GB');
    const approved = cardRow('p1', { approved_by: 'u1', approved_at: '2026-09-21T14:05:00Z' });
    expect(cardFooter(approved, approverLabel('Chitra', 'agency'), 'client', TZ).state).toBe(
      'Approved by Chitra on behalf of the approvers · Sep 21 14:05',
    );
  });
});
