import { describe, expect, it, vi } from 'vitest';
import {
  IDEA_NO_ACCESS,
  createIdeaCardStore,
  ideaHref,
  ideaLine,
  ideaViews,
  ideaWhere,
  looksLikeBundleIdea,
  type IdeaCardView,
} from '@/lib/chat/idea-cards';

type Idea = Extract<IdeaCardView, { kind: 'idea' }>;

function idea(over: Partial<Idea> = {}): Idea {
  return {
    kind: 'idea',
    id: 'i1',
    title: 'Behind the scenes reel',
    planId: null,
    planTitle: null,
    day: null,
    archived: false,
    showToClient: false,
    starred: false,
    comments: 3,
    ...over,
  };
}

describe('idea card line', () => {
  it('a bank idea reads Bank, an archived one Bank · archived', () => {
    expect(ideaWhere(idea())).toBe('Bank');
    expect(ideaWhere(idea({ archived: true }))).toBe('Bank · archived');
    expect(ideaLine(idea())).toBe('Bank · 3 comments');
    expect(ideaLine(idea({ comments: 1 }))).toBe('Bank · 1 comment');
  });

  it('a planned idea reads {plan} · {date}, read live (no snapshot)', () => {
    const planned = idea({ planId: 'p1', planTitle: 'Week of 9 Nov', day: '2026-11-12' });
    expect(ideaLine(planned)).toBe('Week of 9 Nov · 12 Nov · 3 comments');
    expect(ideaWhere({ ...planned, day: null })).toBe('Week of 9 Nov · No date');
    expect(ideaLine(planned)).not.toContain('—');
  });

  it('a tap opens the bank route or the plan item route', () => {
    expect(ideaHref(idea())).toBe('/plan/bank?item=i1');
    expect(ideaHref(idea({ planId: 'p1' }))).toBe('/plan/p1?item=i1');
  });

  it('the no-access line', () => {
    expect(IDEA_NO_ACCESS).toBe("You don't have access to this idea.");
  });
});

describe('ideaViews', () => {
  it('a row RLS hides comes back as no access; titles and counts join', () => {
    const views = ideaViews(
      ['a', 'b'],
      [
        {
          id: 'a',
          title: 'Reel',
          plan_id: 'p1',
          target_date: '2026-11-12',
          archived_at: null,
          show_to_client: false,
          starred_at: null,
        },
      ],
      { a: 2 },
      [{ id: 'p1', title: 'Week of 9 Nov' }],
    );
    expect(views.get('a')).toMatchObject({ kind: 'idea', planTitle: 'Week of 9 Nov', comments: 2 });
    expect(views.get('b')).toEqual({ kind: 'none', id: 'b' });
  });
});

describe('looksLikeBundleIdea', () => {
  const base = {
    body: '',
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    state: 'sent',
  };
  it('an empty recorded row asks; anything with content, a tombstone or a pending send does not', () => {
    expect(looksLikeBundleIdea(base)).toBe(true);
    expect(looksLikeBundleIdea({ ...base, body: 'hi' })).toBe(false);
    expect(looksLikeBundleIdea({ ...base, sharedPlanIds: ['p'] })).toBe(false);
    expect(looksLikeBundleIdea({ ...base, sharedPlanItemIds: ['i'] })).toBe(false);
    expect(looksLikeBundleIdea({ ...base, deleted: true })).toBe(false);
    expect(looksLikeBundleIdea({ ...base, state: 'pending' })).toBe(false);
  });
});

describe('idea card store', () => {
  function manual(): { run: () => void; schedule: (r: () => void) => void } {
    let queued: (() => void) | null = null;
    return {
      run: () => {
        const r = queued;
        queued = null;
        r?.();
      },
      schedule: (r) => {
        queued = r;
      },
    };
  }

  it('asks in one tick become one read (one per thread page)', async () => {
    const ideas = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: new Map(ids.map((id) => [id, idea({ id })] as const)),
    }));
    const messages = vi.fn(async () => ({ ok: true as const, data: new Map<string, string[]>() }));
    const tick = manual();
    const store = createIdeaCardStore({ ideas, messages }, tick.schedule);
    store.request(['a']);
    store.request(['b', 'a']);
    tick.run();
    await vi.waitFor(() => expect(store.get('b')).toBeDefined());
    expect(ideas).toHaveBeenCalledTimes(1);
    expect(ideas.mock.calls[0]?.[0]).toEqual(['a', 'b']);
    expect(messages).not.toHaveBeenCalled();
    // Held ids are never read again on a later ask.
    store.request(['a']);
    tick.run();
    expect(ideas).toHaveBeenCalledTimes(1);
  });

  it('empty-looking bundle rows: one chat_messages read, then one idea read for all ids', async () => {
    const ideas = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: new Map(ids.map((id) => [id, idea({ id })] as const)),
    }));
    const messages = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: new Map(ids.filter((id) => id === 'm1').map((id): [string, string[]] => [id, ['x']])),
    }));
    const tick = manual();
    const store = createIdeaCardStore({ ideas, messages }, tick.schedule);
    store.requestMessages(['m1', 'm2']);
    store.request(['a']);
    tick.run();
    await vi.waitFor(() => expect(store.get('x')).toBeDefined());
    expect(messages).toHaveBeenCalledTimes(1);
    expect(ideas).toHaveBeenCalledTimes(1);
    expect(new Set(ideas.mock.calls[0]?.[0])).toEqual(new Set(['a', 'x']));
    expect(store.messageIdeas('m1')).toEqual(['x']);
    expect(store.messageIdeas('m2')).toEqual([]);
  });

  it('a failed read marks the ids failed; refresh reads them again', async () => {
    let fail = true;
    const ideas = vi.fn(async (ids: string[]) =>
      fail
        ? { ok: false as const, error: { code: 'unknown' as const, message: 'x' } }
        : { ok: true as const, data: new Map(ids.map((id) => [id, idea({ id })] as const)) },
    );
    const tick = manual();
    const store = createIdeaCardStore(
      { ideas, messages: async () => ({ ok: true as const, data: new Map() }) },
      tick.schedule,
    );
    store.request(['a']);
    tick.run();
    await vi.waitFor(() => expect(store.get('a')).toBe('failed'));
    fail = false;
    store.refresh(['a']);
    tick.run();
    await vi.waitFor(() => expect(store.get('a')).toMatchObject({ kind: 'idea' }));
  });
});
