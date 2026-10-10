import { describe, expect, it } from 'vitest';
import {
  eventLabel,
  stageChangeLabel,
  pickNewest,
  splitNewRows,
  summarizeNew,
  toastFromEnriched,
  type EnrichedNew,
  type InboxRow,
} from '@/lib/inbox/inbox-live';
import { UNKNOWN_MEMBER } from '@/lib/chat/mentions';

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
    actor_user_id: null,
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
    mentionNames: new Map(),
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
          mentionNames: new Map(),
        },
      }),
    );
    expect(spec).toEqual({
      title: 'Alice commented on Q3 Launch',
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
          mentionNames: new Map(),
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
          mentionNames: new Map(),
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

describe('comment toast names and title', () => {
  const MANISHA = '0b9d7c1e-1f2a-4c3b-9d8e-7f6a5b4c3d2e';
  const RAHUL = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const GONE = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
  const TITLE = 'Ethyl Acetate - The Ferrari Story';
  const comment = (over: Partial<NonNullable<EnrichedNew['lead']>>): EnrichedNew =>
    enriched({
      lead: {
        eventType: 'comment',
        actorName: 'Chitra',
        actorAvatarUrl: null,
        body: null,
        title: TITLE,
        mentionNames: new Map(),
        ...over,
      },
    });

  it('names the post on line 1 and resolves a mention on line 2', () => {
    const spec = toastFromEnriched(
      comment({
        body: `@[${MANISHA}] can we post this today`,
        mentionNames: new Map([[MANISHA, 'Manisha']]),
      }),
    );
    expect(spec?.title).toBe('Chitra commented on Ethyl Acetate - The Ferrari Story');
    expect(spec?.description).toBe('@Manisha can we post this today');
  });

  it('names a brief on line 1 the same way', () => {
    expect(toastFromEnriched(comment({ title: 'Diwali brief' }))?.title).toBe(
      'Chitra commented on Diwali brief',
    );
  });

  it('resolves two mentions', () => {
    const spec = toastFromEnriched(
      comment({
        body: `@[${MANISHA}] and @[${RAHUL}] please check`,
        mentionNames: new Map([
          [MANISHA, 'Manisha'],
          [RAHUL, 'Rahul'],
        ]),
      }),
    );
    expect(spec?.description).toBe('@Manisha and @Rahul please check');
  });

  it('renders an unknown id as the resolver does', () => {
    const spec = toastFromEnriched(comment({ body: `@[${GONE}] ping` }));
    expect(spec?.description).toBe(`@${UNKNOWN_MEMBER} ping`);
  });

  it('drops line 2 when the name read failed, never showing a raw token', () => {
    const spec = toastFromEnriched(
      comment({ body: `@[${MANISHA}] can we post this today`, mentionNames: null }),
    );
    expect(spec?.title).toBe('Chitra commented on Ethyl Acetate - The Ferrari Story');
    expect(spec && 'description' in spec).toBe(false);
    expect(JSON.stringify(spec)).not.toContain('@[');
  });

  it('reads "New comment on <title>" with no line 2 when the name read failed', () => {
    const spec = toastFromEnriched(
      comment({
        actorName: null,
        body: `@[${MANISHA}] can we post this today`,
        mentionNames: null,
      }),
    );
    expect(spec?.title).toBe('New comment on Ethyl Acetate - The Ferrari Story');
    expect(spec && 'description' in spec).toBe(false);
    expect(JSON.stringify(spec)).not.toContain('@[');
    expect(JSON.stringify(spec)).not.toContain('can we post');
  });

  it('keeps the generic label when the name read failed and the title is missing', () => {
    const spec = toastFromEnriched(
      comment({ actorName: null, title: null, body: 'Ship it', mentionNames: null }),
    );
    expect(spec?.title).toBe('New comment');
    expect(spec && 'description' in spec).toBe(false);
  });

  it('drops line 2 for a token-free body too when the name read failed', () => {
    const spec = toastFromEnriched(comment({ body: 'Ship it', mentionNames: null }));
    expect(spec && 'description' in spec).toBe(false);
  });

  it('reads "<actor> commented" when the title is missing', () => {
    const spec = toastFromEnriched(comment({ title: null, body: 'Ship it' }));
    expect(spec?.title).toBe('Chitra commented');
    expect(spec?.description).toBe('Ship it');
  });

  it('truncates after resolving names', () => {
    const tail = 'x'.repeat(200);
    const spec = toastFromEnriched(
      comment({ body: `@[${MANISHA}] ${tail}`, mentionNames: new Map([[MANISHA, 'Manisha']]) }),
    );
    const expected = `@Manisha ${tail}`.slice(0, 100);
    expect(spec?.description).toBe(`${expected}\u2026`);
    expect(spec?.description).not.toContain('@[');
  });
});

describe('chat mention rows in the live layer', () => {
  it('a chat mention row counts as new and toasts as a mention', () => {
    const since = Date.parse('2026-06-14T12:00:00.000Z');
    const chat = row({
      id: 'e-chat',
      event_type: 'mention',
      entity_type: 'chat_channel',
      entity_id: 'chan-1',
      scope: 'groups',
      tier: 'urgent',
      actor_user_id: 'u-bob',
      payload: { message_id: 'msg-1' },
      created_at: '2026-06-14T12:00:01.000Z',
    });
    const summary = summarizeNew([chat], since);
    expect(summary.newRows).toEqual([chat]);
    expect(pickNewest([chat])).toBe(chat);
    expect(
      toastFromEnriched(enriched({ lead: { ...enriched({}).lead!, eventType: 'mention' } }))?.title,
    ).toBe('New mention');
  });
});

describe('live toast labels for approve, reject, park and deletes', () => {
  it('stage_change names the outcome; anything else is "Post moved"', () => {
    expect(stageChangeLabel('approved')).toBe('Post approved');
    expect(stageChangeLabel('rejected')).toBe('Post rejected');
    expect(stageChangeLabel('parked')).toBe('Post parked');
    expect(stageChangeLabel('review')).toBe('Post moved');
    expect(stageChangeLabel(null)).toBe('Post moved');
    expect(eventLabel('stage_change', 'approved')).toBe('Post approved');
  });

  it('plan_comment and plan_review have their own labels', () => {
    expect(eventLabel('plan_comment')).toBe('New plan comment');
    expect(eventLabel('plan_review')).toBe('Plan item reviewed');
  });

  it('post_deleted and assets_deleted have their own labels', () => {
    expect(eventLabel('post_deleted')).toBe('Post deleted');
    expect(eventLabel('assets_deleted')).toBe('Assets deleted');
  });

  it('a single stage_change lead with its target stage toasts the outcome', () => {
    const spec = toastFromEnriched({
      count: 1,
      lead: {
        eventType: 'stage_change',
        actorName: null,
        actorAvatarUrl: null,
        body: null,
        title: 'Q3 Launch',
        mentionNames: new Map(),
        toStage: 'rejected',
      },
    });
    expect(spec?.title).toBe('Post rejected');
  });

  it('the two delete types are Activity rows, not bell rows', () => {
    const base = {
      id: 'e',
      user_id: 'u',
      workspace_id: 'w',
      entity_id: 'x',
      scope: 'posts',
      scope_key: null,
      tier: 'active',
      payload: {},
      read_at: null,
      snoozed_until: null,
      actor_user_id: 'u2',
      email_sent_at: null,
      deleted_at: null,
      created_at: '2026-10-07T00:00:00.000Z',
    };
    const rows = [
      { ...base, event_type: 'post_deleted', entity_type: 'post' },
      { ...base, event_type: 'assets_deleted', entity_type: 'workspace' },
    ];
    const split = splitNewRows(rows);
    expect(split.activity).toHaveLength(2);
    expect(split.chatMentions).toHaveLength(0);
  });
});
