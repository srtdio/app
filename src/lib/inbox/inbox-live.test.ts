import { describe, expect, it } from 'vitest';
import {
  pickNewest,
  summarizeNew,
  toastFromEnriched,
  type EnrichedNew,
  type InboxRow,
} from '@/lib/inbox/inbox-live';

function row(over: Partial<InboxRow>): InboxRow {
  return {
    id: 'e1',
    user_id: 'u1',
    workspace_id: 'w1',
    event_type: 'comment',
    entity_type: 'post',
    entity_id: 'p1',
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: '2026-06-14T00:00:00.000Z',
    ...over,
  };
}

const enriched = (over: Partial<EnrichedNew>): EnrichedNew => ({
  count: 1,
  lead: {
    eventType: 'comment',
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    title: null,
  },
  ...over,
});

describe('summarizeNew', () => {
  const since = Date.parse('2026-06-14T12:00:00.000Z');

  it('excludes rows at or before the high-water mark', () => {
    const rows = [
      row({ id: 'old', created_at: '2026-06-14T11:00:00.000Z' }),
      row({ id: 'edge', created_at: '2026-06-14T12:00:00.000Z' }),
    ];
    const { newRows } = summarizeNew(rows, since);
    expect(newRows).toEqual([]);
  });

  it('keeps rows strictly newer and advances the mark to the newest', () => {
    const rows = [
      row({ id: 'new-a', created_at: '2026-06-14T12:30:00.000Z' }),
      row({ id: 'new-b', created_at: '2026-06-14T13:15:00.000Z' }),
      row({ id: 'old', created_at: '2026-06-14T09:00:00.000Z' }),
    ];
    const { newRows, nextHighWaterMs } = summarizeNew(rows, since);
    expect(newRows.map((r) => r.id)).toEqual(['new-a', 'new-b']);
    expect(nextHighWaterMs).toBe(Date.parse('2026-06-14T13:15:00.000Z'));
  });

  it('never lowers the mark and ignores unparseable timestamps', () => {
    const rows = [row({ id: 'bad', created_at: 'not-a-date' })];
    const { newRows, nextHighWaterMs } = summarizeNew(rows, since);
    expect(newRows).toEqual([]);
    expect(nextHighWaterMs).toBe(since);
  });
});

describe('pickNewest', () => {
  it('returns null for an empty list', () => {
    expect(pickNewest([])).toBeNull();
  });
  it('returns the row with the newest created_at', () => {
    const newest = row({ id: 'newest', created_at: '2026-06-14T13:00:00.000Z' });
    const got = pickNewest([row({ id: 'a', created_at: '2026-06-14T10:00:00.000Z' }), newest]);
    expect(got?.id).toBe('newest');
  });
});

describe('toastFromEnriched', () => {
  it('returns null when there are no new rows', () => {
    expect(toastFromEnriched(enriched({ count: 0, lead: null }))).toBeNull();
  });

  it('names the actor for a single comment and uses the body as the snippet', () => {
    const spec = toastFromEnriched(
      enriched({
        lead: {
          eventType: 'comment',
          actorName: 'Alice',
          actorAvatarUrl: 'https://cdn/a.png',
          body: 'Looks great, ship it!',
          title: 'Q3 Launch',
        },
      }),
    );
    expect(spec).toEqual({
      title: 'Alice commented',
      description: 'Looks great, ship it!',
      actorName: 'Alice',
      actorAvatarUrl: 'https://cdn/a.png',
    });
  });

  it('labels a single non-comment event and falls back to the title for the snippet', () => {
    const spec = toastFromEnriched(
      enriched({
        lead: {
          eventType: 'stage_change',
          actorName: null,
          actorAvatarUrl: null,
          body: null,
          title: 'Q3 Launch',
        },
      }),
    );
    expect(spec).toEqual({
      title: 'Post moved',
      description: 'Q3 Launch',
      actorName: null,
      actorAvatarUrl: null,
    });
  });

  it('omits the description when neither body nor title is present', () => {
    const spec = toastFromEnriched(
      enriched({
        lead: {
          eventType: 'brief_created',
          actorName: null,
          actorAvatarUrl: null,
          body: null,
          title: null,
        },
      }),
    );
    expect(spec).toEqual({ title: 'New brief', actorName: null, actorAvatarUrl: null });
    expect(spec && 'description' in spec).toBe(false);
  });

  it('coalesces many new rows into a spelled-number summary with no actor', () => {
    expect(toastFromEnriched(enriched({ count: 3, lead: null }))).toEqual({
      title: 'Three new updates',
      actorName: null,
      actorAvatarUrl: null,
    });
    expect(toastFromEnriched(enriched({ count: 12, lead: null }))?.title).toBe('12 new updates');
  });
});
