import { describe, expect, it } from 'vitest';
import {
  POLL_CHANGE_SOURCE,
  REOPEN_VERB,
  actionKey,
  eventLabel,
  eventVerb,
  stageChangeLabel,
  pickNewest,
  splitNewRows,
  summarizeNew,
  toastFromEnriched,
  mentionTabText,
  unseenRows,
  type EnrichedNew,
  type InboxRow,
  type ToastUpdate,
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

  it('coalesces many new rows with no actor into "New activity +{N-1}"', () => {
    expect(toastFromEnriched(enriched({ count: 3, lead: null }))).toEqual({
      title: 'New activity +2',
      actorName: null,
      actorAvatarUrl: null,
    });
    expect(toastFromEnriched(enriched({ count: 12, lead: null }))?.title).toBe('New activity +11');
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
        mentionNames: new Map([[MANISHA, '@Manisha']]),
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
          [MANISHA, '@Manisha'],
          [RAHUL, '@Rahul'],
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
      comment({ body: `@[${MANISHA}] ${tail}`, mentionNames: new Map([[MANISHA, '@Manisha']]) }),
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

  it('a plan_review withdrawal names who withdrew what', () => {
    expect(
      eventLabel('plan_review', null, { withdrawn: true, previous: 'approved', actorName: 'Cy' }),
    ).toBe('Cy withdrew slot approval');
    expect(
      eventLabel('plan_review', null, { withdrawn: true, previous: 'changes', actorName: 'Cy' }),
    ).toBe('Cy withdrew their changes request');
    expect(eventLabel('plan_review', null, { withdrawn: true, previous: 'approved' })).toBe(
      'Slot approval withdrawn',
    );
    expect(
      eventLabel('plan_review', null, { withdrawn: true, previous: 'changes', actorName: null }),
    ).toBe('Changes request withdrawn');
    expect(eventLabel('plan_review', null, { withdrawn: false, actorName: 'Cy' })).toBe(
      'Plan item reviewed',
    );
    const spec = toastFromEnriched(
      enriched({
        lead: {
          eventType: 'plan_review',
          actorName: 'Cy',
          actorAvatarUrl: null,
          body: null,
          title: null,
          mentionNames: new Map(),
          reviewWithdrawn: true,
          reviewPrevious: 'approved',
        },
      }),
    );
    expect(spec?.title).toBe('Cy withdrew slot approval');
  });

  it('post_deleted and assets_deleted have their own labels', () => {
    expect(eventLabel('post_deleted')).toBe('Post deleted');
    expect(eventLabel('assets_deleted')).toBe('Assets deleted');
    expect(eventLabel('asset_uploaded')).toBe('New file');
    expect(eventLabel('asset_version_added')).toBe('New file');
    expect(eventVerb({ eventType: 'asset_uploaded' })).toBe('uploaded a file');
    expect(eventVerb({ eventType: 'asset_version_added' })).toBe('added a file version');
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

describe('grouped toast wording', () => {
  const up = (actorId: string | null, entityKey: string | null, action: string): ToastUpdate => ({
    actorId,
    entityKey,
    action,
  });
  const lead = (over: Partial<NonNullable<EnrichedNew['lead']>> = {}): EnrichedNew['lead'] => ({
    eventType: 'comment',
    actorName: 'Asha Rao',
    actorAvatarUrl: 'https://cdn/asha.png',
    body: null,
    title: 'Q3 Launch',
    mentionNames: new Map(),
    verb: 'commented',
    ...over,
  });
  const spec = (count: number, updates: ToastUpdate[], l = lead()) =>
    toastFromEnriched({ count, lead: l, updates });

  it('one update: "{Name} {verb} on {post title}"', () => {
    expect(spec(1, [up('a', 'post:p1', 'comment')])?.title).toBe('Asha Rao commented on Q3 Launch');
    const approved = lead({ eventType: 'stage_change', toStage: 'approved', verb: 'approved' });
    expect(spec(1, [up('a', 'post:p1', 'stage_change:approved')], approved)?.title).toBe(
      'Asha Rao approved on Q3 Launch',
    );
  });

  it('same post and action, different people: "and N others" (1 other)', () => {
    expect(spec(2, [up('a', 'post:p1', 'comment'), up('b', 'post:p1', 'comment')])?.title).toBe(
      'Asha Rao and 1 other commented on Q3 Launch',
    );
    expect(
      spec(4, [
        up('a', 'post:p1', 'comment'),
        up('b', 'post:p1', 'comment'),
        up('c', 'post:p1', 'comment'),
        up('b', 'post:p1', 'comment'),
      ])?.title,
    ).toBe('Asha Rao and 2 others commented on Q3 Launch');
  });

  it('same person, post and action, repeated: "{Name} {verb} N times on {title}"', () => {
    expect(
      spec(3, [
        up('a', 'post:p1', 'comment'),
        up('a', 'post:p1', 'comment'),
        up('a', 'post:p1', 'comment'),
      ])?.title,
    ).toBe('Asha Rao commented 3 times on Q3 Launch');
  });

  const diwaliApproved = lead({
    eventType: 'stage_change',
    toStage: 'approved',
    verb: 'approved',
    title: 'Diwali post',
  });

  it('same person, different posts or actions: "{Name} {verb} {title} +{N-1}" from the newest', () => {
    expect(
      spec(
        4,
        [up('a', 'post:p1', 'stage_change:approved'), up('a', 'post:p2', 'comment')],
        diwaliApproved,
      )?.title,
    ).toBe('Asha Rao approved Diwali post +3');
    expect(
      spec(
        2,
        [up('a', 'post:p1', 'stage_change:approved'), up('a', 'post:p1', 'comment')],
        diwaliApproved,
      )?.title,
    ).toBe('Asha Rao approved Diwali post +1');
  });

  it('different people, different posts or actions: "{Name} {verb} {title} +{N-1}" from the newest', () => {
    expect(
      spec(
        2,
        [up('a', 'post:p1', 'stage_change:approved'), up('b', 'post:p2', 'comment')],
        diwaliApproved,
      )?.title,
    ).toBe('Asha Rao approved Diwali post +1');
    expect(
      spec(
        5,
        [
          up('a', 'post:p1', 'stage_change:approved'),
          up('b', 'post:p2', 'mention'),
          up('c', 'post:p2', 'comment'),
        ],
        diwaliApproved,
      )?.title,
    ).toBe('Asha Rao approved Diwali post +4');
  });

  it('mixed with send for review as the newest keeps the wrapped title', () => {
    const review = lead({
      eventType: 'stage_change',
      toStage: 'review',
      verb: eventVerb({ eventType: 'stage_change', toStage: 'review' }),
      title: 'Diwali post',
    });
    expect(
      spec(4, [up('a', 'post:p1', 'stage_change:review'), up('b', 'post:p2', 'comment')], review)
        ?.title,
    ).toBe('Asha Rao sent Diwali post for review +3');
  });

  it('mixed with no verb or no title on the newest: "{Name} +{N-1}"', () => {
    const mixed = [up('a', 'post:p1', 'post_ready'), up('a', 'post:p2', 'comment')];
    expect(spec(3, mixed, lead({ verb: null }))?.title).toBe('Asha Rao +2');
    expect(spec(3, mixed, lead({ title: null }))?.title).toBe('Asha Rao +2');
    expect(spec(3, mixed, lead({ title: '  ' }))?.title).toBe('Asha Rao +2');
  });

  it('no grouped or fallback title ever says "updates"', () => {
    const titles = [
      spec(2, [up('a', 'post:p1', 'comment'), up('a', 'post:p2', 'comment')])?.title,
      spec(3, [up('a', 'post:p1', 'comment'), up('b', 'post:p2', 'mention')])?.title,
      spec(3, [up('a', 'post:p1', 'comment'), up('b', 'post:p2', 'comment')], lead({ verb: null }))
        ?.title,
      spec(3, [up('a', 'post:p1', 'comment'), up('b', 'post:p1', 'comment')])?.title,
      spec(3, [up('a', 'post:p1', 'comment'), up('a', 'post:p1', 'comment')])?.title,
      toastFromEnriched({ count: 3, lead: null })?.title,
      toastFromEnriched({ count: 3, lead: lead({ actorName: null }), updates: [] })?.title,
    ];
    for (const title of titles) {
      expect(title).toBeDefined();
      expect(title).not.toMatch(/updates/i);
    }
  });

  it('the count is the exact total, beyond the rows read', () => {
    const ten = Array.from({ length: 10 }, () => up('a', 'post:p1', 'comment'));
    expect(spec(14, ten)?.title).toBe('Asha Rao commented 14 times on Q3 Launch');
  });

  it('the toast avatar is the newest update actor; a former member reads "Former member"', () => {
    const s1 = spec(2, [up('a', 'post:p1', 'comment'), up('b', 'post:p1', 'comment')]);
    expect(s1?.actorName).toBe('Asha Rao');
    expect(s1?.actorAvatarUrl).toBe('https://cdn/asha.png');
    const gone = spec(
      1,
      [up('x', 'post:p1', 'comment')],
      lead({ actorName: 'Former member', actorAvatarUrl: null }),
    );
    expect(gone?.title).toBe('Former member commented on Q3 Launch');
  });
});

describe('send for review wording', () => {
  const up = (actorId: string): ToastUpdate => ({
    actorId,
    entityKey: 'post:p1',
    action: 'stage_change:review',
  });
  const lead = (eventType: string): EnrichedNew['lead'] => ({
    eventType,
    actorName: 'Asha Rao',
    actorAvatarUrl: null,
    body: null,
    title: 'Q3 Launch',
    mentionNames: new Map(),
    verb: eventVerb({ eventType, toStage: 'review' }),
  });

  it('one update: "{Name} sent {title} for review" (stage change and ready ping)', () => {
    for (const type of ['stage_change', 'post_ready']) {
      expect(toastFromEnriched({ count: 1, lead: lead(type), updates: [up('a')] })?.title).toBe(
        'Asha Rao sent Q3 Launch for review',
      );
    }
  });

  it('grouped: "{Name} and N others sent {title} for review"', () => {
    const spec = toastFromEnriched({
      count: 3,
      lead: lead('stage_change'),
      updates: [up('a'), up('b'), up('c')],
    });
    expect(spec?.title).toBe('Asha Rao and 2 others sent Q3 Launch for review');
    const one = toastFromEnriched({
      count: 2,
      lead: lead('post_ready'),
      updates: [up('a'), up('b')],
    });
    expect(one?.title).toBe('Asha Rao and 1 other sent Q3 Launch for review');
  });

  it('repeat: "{Name} sent {title} for review N times"', () => {
    const spec = toastFromEnriched({
      count: 3,
      lead: lead('stage_change'),
      updates: [up('a'), up('a'), up('a')],
    });
    expect(spec?.title).toBe('Asha Rao sent Q3 Launch for review 3 times');
  });

  it('never "sent for review on"', () => {
    const spec = toastFromEnriched({ count: 1, lead: lead('post_ready'), updates: [up('a')] });
    expect(spec?.title).not.toContain('for review on');
  });
});

describe('othersRows (own already-read rows never toast or tone)', () => {
  it('drops rows whose actor is the viewer', async () => {
    const { othersRows } = await import('@/lib/inbox/inbox-live');
    const rows = [
      { id: 'a', actor_user_id: 'me' },
      { id: 'b', actor_user_id: 'them' },
      { id: 'c', actor_user_id: null },
    ];
    expect(othersRows(rows, 'me').map((r) => r.id)).toEqual(['b', 'c']);
  });
});

describe('activityToneWanted', () => {
  it('tones for someone else’s new rows unless Notifications is open', async () => {
    const { activityToneWanted } = await import('@/lib/inbox/inbox-live');
    expect(activityToneWanted(1, '/pipeline')).toBe(true);
    expect(activityToneWanted(0, '/pipeline')).toBe(false);
    expect(activityToneWanted(2, '/notifications')).toBe(false);
  });
});

describe('activityToneWanted in a background tab', () => {
  it('tones even on Notifications when the tab is hidden', async () => {
    const { activityToneWanted } = await import('@/lib/inbox/inbox-live');
    expect(activityToneWanted(1, '/notifications', true)).toBe(true);
    expect(activityToneWanted(0, '/notifications', true)).toBe(false);
  });
});

describe('brief reopened live toast', () => {
  const reopened = (over: Partial<NonNullable<EnrichedNew['lead']>> = {}): EnrichedNew['lead'] => ({
    eventType: 'brief_reopened',
    actorName: 'Asha Rao',
    actorAvatarUrl: null,
    body: null,
    title: 'Diwali brief',
    mentionNames: new Map(),
    verb: eventVerb({ eventType: 'brief_reopened' }),
    ...over,
  });

  it('the verb is "reopened" and it takes the title directly', () => {
    expect(REOPEN_VERB).toBe('reopened');
    expect(eventVerb({ eventType: 'brief_reopened' })).toBe(REOPEN_VERB);
    expect(actionKey({ eventType: 'brief_reopened' })).toBe('brief_reopened');
  });

  it('one reopen reads "{name} reopened {title}", never "reopened on"', () => {
    const spec = toastFromEnriched({ count: 1, lead: reopened() });
    expect(spec?.title).toBe('Asha Rao reopened Diwali brief');
    expect(spec?.title).not.toContain('reopened on');
    expect(spec?.actorName).toBe('Asha Rao');
  });

  it('no title: "{name} reopened"', () => {
    expect(toastFromEnriched({ count: 1, lead: reopened({ title: null }) })?.title).toBe(
      'Asha Rao reopened',
    );
    expect(toastFromEnriched({ count: 1, lead: reopened({ title: '  ' }) })?.title).toBe(
      'Asha Rao reopened',
    );
  });

  it('no actor name: the neutral "Brief reopened" label, the title as line 2', () => {
    expect(eventLabel('brief_reopened')).toBe('Brief reopened');
    const spec = toastFromEnriched({ count: 1, lead: reopened({ actorName: null }) });
    expect(spec?.title).toBe('Brief reopened');
    expect(spec?.description).toBe('Diwali brief');
  });

  it('grouped reopens keep the "reopened {title}" grammar', () => {
    const up = (actorId: string): ToastUpdate => ({
      actorId,
      entityKey: 'brief:b1',
      action: 'brief_reopened',
    });
    const grouped = (updates: ToastUpdate[]) =>
      toastFromEnriched({ count: 2, lead: reopened(), updates })?.title;
    expect(grouped([up('a'), up('a')])).toBe('Asha Rao reopened Diwali brief 2 times');
    expect(grouped([up('a'), up('b')])).toBe('Asha Rao and 1 other reopened Diwali brief');
  });
});

describe('notifications fixes: the live layer', () => {
  it('fix 15: the poll tags its inbox-changed event, unlike a local write', () => {
    expect(POLL_CHANGE_SOURCE).toBe('poll');
  });

  it('fix 20: unseenRows toasts a row once, even when two overlapping ticks read it', () => {
    const seen = new Set<string>();
    const first = unseenRows([row({ id: 'a' }), row({ id: 'b' })], seen);
    expect(first.map((r) => r.id)).toEqual(['a', 'b']);
    const second = unseenRows([row({ id: 'b' }), row({ id: 'c' })], seen);
    expect(second.map((r) => r.id)).toEqual(['c']);
    expect(unseenRows([row({ id: 'a' })], seen)).toEqual([]);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('fix 29: one chat mention speaks on the tab as "<Name> mentioned you"', () => {
    expect(mentionTabText('Priya')).toBe('Priya mentioned you');
    expect(mentionTabText(null)).toBe('Someone mentioned you');
  });
});
