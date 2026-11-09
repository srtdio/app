import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import {
  bodyOf,
  commentRows,
  contextLabel,
  defaultPointOpen,
  dueWords,
  eventRows,
  firstNewOf,
  lineWithoutName,
} from '@/lib/catch-up/body';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';

const comment = (over: Partial<Parameters<typeof commentRows>[1][number]>) => ({
  id: 'c',
  entity_id: 'p1',
  author_user_id: 'u1',
  body: 'Hi',
  created_at: '2026-11-08T10:00:00Z',
  parent_comment_id: null,
  ledger_batch_id: null,
  ledger_seq: null,
  resolved_at: null,
  closed_at: null,
  accepted_at: null,
  ...over,
});

describe('catch-up bodies', () => {
  it('the line without the name', () => {
    expect(lineWithoutName('Maya sent Monday carousel for review', 'Maya')).toBe(
      'Sent Monday carousel for review',
    );
    expect(lineWithoutName('approved it', null)).toBe('Approved it');
  });

  it('context labels', () => {
    expect(contextLabel({ kind: 'post', pictures: 5, video: false })).toBe('Caption · 5 pictures');
    expect(contextLabel({ kind: 'post', pictures: 0, video: true })).toBe('Caption · Video');
    expect(contextLabel({ kind: 'post', pictures: 0, video: false })).toBe('Caption');
    expect(contextLabel({ kind: 'brief', pictures: 0, video: false })).toBe('Brief');
    expect(contextLabel({ kind: 'plan-item', pictures: 0, video: false, planTitle: 'Nov' })).toBe(
      'Plan · Nov',
    );
    expect(contextLabel({ kind: 'idea', pictures: 0, video: false })).toBe('Idea · Bank');
  });

  it('due words: "Due" ahead, late in bad, none without a day', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    expect(dueWords(null, 'UTC', now)).toBeNull();
    expect(dueWords('2026-11-12T12:00:00Z', 'UTC', now)?.text).toMatch(/^Due /);
    expect(dueWords('2026-11-07T12:00:00Z', 'UTC', now)).toEqual({ text: '2d late', bad: true });
  });

  it('feedback points group per batch; open points start expanded, resolved folded', () => {
    const rows = commentRows(
      'w1',
      [
        comment({ id: 'a', ledger_batch_id: 'b1', ledger_seq: 1 }),
        comment({
          id: 'b',
          ledger_batch_id: 'b1',
          ledger_seq: 2,
          resolved_at: '2026-11-08T11:00:00Z',
        }),
        comment({ id: 'c' }),
      ],
      new Map([['a', 2]]),
    );
    expect(rows.map((r) => r.kind)).toEqual(['points', 'message']);
    const points = rows[0];
    if (points?.kind !== 'points') throw new Error('points');
    expect(points.points.map((p) => [p.n, p.open, p.replyCount])).toEqual([
      [1, true, 2],
      [2, false, 0],
    ]);
    expect(points.points.map(defaultPointOpen)).toEqual([true, false]);
  });

  it('event rows for stage changes, without the name', () => {
    const card = cardOf(
      entry({ id: 's', event_type: 'stage_change', payload: { to_stage: 'review' } }),
    );
    const rows = eventRows(card);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('event:s');
    expect(rows[0]?.author.name).toBe('Someone');
  });

  it('the New line sits at the oldest unread card entry', () => {
    const card = cardOf(
      entry({ id: 'e2', created_at: '2026-11-08T11:00:00Z', payload: { comment_id: 'c2' } }),
      entry({ id: 'e1', created_at: '2026-11-08T10:00:00Z', payload: { comment_id: 'c1' } }),
    );
    const rows = commentRows(
      'w1',
      [comment({ id: 'c0' }), comment({ id: 'c1' }), comment({ id: 'c2' })],
      new Map(),
    );
    expect(firstNewOf(card, rows)).toBe('c1');
  });

  it('skips a deleted post, an approver on a draft, and never renders an empty card', () => {
    const card = cardOf(entry({ id: 'e', payload: { comment_id: 'c' } }));
    const parts = {
      workspaceId: 'w1',
      side: 'agency' as const,
      zone: 'UTC',
      post: {
        title: 'T',
        caption: '',
        format: 'text',
        target_date: null,
        stage: 'review',
        deleted_at: null,
      },
      brief: undefined,
      planItem: undefined,
      planTitle: new Map<string, string>(),
      pictures: { images: [], video: null },
      comments: [comment({ id: 'c' })],
      planComments: [],
      counts: new Map<string, number>(),
    };
    const ok = bodyOf(card, parts);
    expect(ok).not.toBe('skip');
    if (ok !== 'skip' && ok !== 'error') {
      // Text-only post with no caption: no strip.
      expect(ok.context).toBeNull();
      expect(ok.threads).toBe(true);
    }
    expect(
      bodyOf(card, { ...parts, post: { ...parts.post, deleted_at: '2026-11-08T00:00:00Z' } }),
    ).toBe('skip');
    expect(
      bodyOf(card, { ...parts, side: 'client', post: { ...parts.post, stage: 'draft' } }),
    ).toBe('skip');
    expect(bodyOf(card, { ...parts, post: undefined })).toBe('skip');
    // Its comment not drawn: the unread entry still gets its own line (9 Nov 2026), never empty.
    const lineOnly = bodyOf(card, { ...parts, comments: [] });
    if (lineOnly === 'skip' || lineOnly === 'error') throw new Error('line only');
    expect(lineOnly.rows.map((r) => r.kind)).toEqual(['event']);
  });
});

describe('catch up: every unread notification is a line (9 Nov 2026)', () => {
  const at = (h: number): string => `2026-11-08T${String(h).padStart(2, '0')}:00:00.000Z`;
  const postParts = (comments: Parameters<typeof commentRows>[1]) => ({
    workspaceId: 'w1',
    side: 'agency' as const,
    zone: 'UTC',
    post: {
      title: 'Launch reel',
      caption: '',
      format: 'text',
      target_date: null,
      stage: 'review',
      deleted_at: null,
    },
    brief: undefined,
    planItem: undefined,
    planTitle: new Map<string, string>(),
    pictures: { images: [], video: null },
    comments: [...comments].reverse(),
    planComments: [],
    counts: new Map<string, number>(),
  });

  it('3 unread comments: 1 card, 3 message rows, the New line above the first', () => {
    const card = cardOf(
      entry({ id: 'e3', created_at: at(11), payload: { comment_id: 'c3' } }),
      entry({ id: 'e2', created_at: at(10), payload: { comment_id: 'c2' } }),
      entry({ id: 'e1', created_at: at(9), payload: { comment_id: 'c1' } }),
    );
    const body = bodyOf(
      card,
      postParts([
        comment({ id: 'c1', created_at: at(9) }),
        comment({ id: 'c2', created_at: at(10) }),
        comment({ id: 'c3', created_at: at(11) }),
      ]),
    );
    if (body === 'skip' || body === 'error') throw new Error('body');
    expect(body.rows.map((r) => [r.kind, r.id])).toEqual([
      ['message', 'c1'],
      ['message', 'c2'],
      ['message', 'c3'],
    ]);
    expect(body.firstNewId).toBe('c1');
  });

  it('a comment + plan_date_changed + post_ready: 1 message row + 2 event lines', () => {
    const card = cardOf(
      entry({ id: 'cm', created_at: at(9), payload: { comment_id: 'c1' } }),
      entry({ id: 'pd', event_type: 'plan_date_changed', created_at: at(10) }),
      entry({ id: 'pr', event_type: 'post_ready', created_at: at(11) }),
    );
    const body = bodyOf(card, postParts([comment({ id: 'c1', created_at: at(9) })]));
    if (body === 'skip' || body === 'error') throw new Error('body');
    expect(body.rows.map((r) => r.kind)).toEqual(['message', 'event', 'event']);
    expect(body.rows.map((r) => r.id)).toEqual(['c1', 'event:pd', 'event:pr']);
    // The New line sits above the oldest unread line of any kind.
    expect(body.firstNewId).toBe('c1');
  });

  it('a mention and a comment on one comment share its one message row', () => {
    const card = cardOf(
      entry({ id: 'cm', created_at: at(9), payload: { comment_id: 'c1' } }),
      entry({ id: 'mn', event_type: 'mention', created_at: at(9), payload: { comment_id: 'c1' } }),
    );
    const drawn = commentRows('w1', [comment({ id: 'c1', created_at: at(9) })], new Map());
    expect(eventRows(card, drawn)).toEqual([]);
  });

  it('own and read entries get no line; unknown types read a fallback; a missing actor is "Someone"', () => {
    const base = cardOf(entry({ id: 'cm', created_at: at(9), payload: { comment_id: 'c1' } }));
    const own = entry({ id: 'own', event_type: 'post_ready', created_at: at(10) }, { own: true });
    const read = entry({ id: 'rd', event_type: 'post_ready', created_at: at(10), read_at: at(10) });
    const odd = entry(
      { id: 'odd', event_type: 'something_new', created_at: at(11), actor_user_id: null },
      { actorName: null },
    );
    const card = { ...base, entries: [...base.entries, own, read, odd] };
    const drawn = commentRows('w1', [comment({ id: 'c1', created_at: at(9) })], new Map());
    const rows = eventRows(card, drawn);
    expect(rows.map((r) => r.id)).toEqual(['event:odd']);
    expect(rows[0]?.author.name).toBe('Someone');
    expect(rows[0]?.line.length).toBeGreaterThan(0);
  });
});
