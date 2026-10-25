import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ThreadReplyCount } from '@/lib/chat/history';
import type { Result } from '@srtdio/rpc';
import {
  NO_RAIL,
  OWN_REACH,
  THREAD_COUNTS_WAIT_MS,
  createThreadCounts,
  freezeMemberships,
  isRootCard,
  localReplyCounts,
  membershipOf,
  pageCountRoots,
  railPlans,
  renderedMembership,
  replyCountLabel,
  rowGeometry,
  senderRootFor,
  threadReplyCount,
  withThreadRoot,
  type MembershipMap,
  type RailItem,
  type ThreadMembership,
} from '@/lib/chat/thread-rail';

function msg(id: string, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    senderUserId: 'u1',
    body: id,
    createdAt: '2026-10-01T10:00:00Z',
    time: Date.parse('2026-10-01T10:00:00Z'),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

const card = (id: string, postId = 'p1'): ThreadMessage => msg(id, { sharedPostIds: [postId] });
const reply = (id: string, parent: string, root?: string): ThreadMessage =>
  msg(id, {
    reply: { id: parent, authorUserId: null, preview: 'x' },
    ...(root !== undefined ? { threadRootId: root } : {}),
  });

const byIdOf = (rows: ThreadMessage[]): Map<string, ThreadMessage> =>
  new Map(rows.map((m) => [m.id, m]));

describe('senderRootFor / withThreadRoot', () => {
  it('derives the trigger rule: the parent root, else the parent id; unknown stays unknown', () => {
    expect(senderRootFor(card('c'))).toBe('c');
    expect(senderRootFor(reply('r', 'c', 'c'))).toBe('c');
    expect(senderRootFor(reply('r', 'c'))).toBeUndefined();
  });

  it('rides the root on the reply quote only for the loaded parent it names', () => {
    const quote = { id: 'c', authorUserId: null, preview: 'Shared post' };
    expect(withThreadRoot(quote, card('c'))).toEqual({ ...quote, rootId: 'c' });
    expect(withThreadRoot(quote, card('other'))).toBe(quote);
    expect(withThreadRoot(quote, undefined)).toBe(quote);
    expect(withThreadRoot(null, card('c'))).toBeNull();
  });
});

describe('membership', () => {
  it('a reply rooted at a post card is a member; a plain root keeps the quote', () => {
    const rows = [card('c'), msg('plain'), reply('r1', 'c', 'c'), reply('r2', 'plain', 'plain')];
    const byId = byIdOf(rows);
    expect(membershipOf(rows[2] as ThreadMessage, byId, new Map())).toEqual({
      rootId: 'c',
      postId: 'p1',
    });
    expect(membershipOf(rows[3] as ThreadMessage, byId, new Map())).toBeNull();
    expect(membershipOf(card('c'), byId, new Map())).toBeNull();
  });

  it('a not-loaded root reads its hydrated post ids; unknown until then', () => {
    const r = reply('r', 'x', 'root');
    expect(membershipOf(r, new Map(), new Map())).toBeUndefined();
    expect(membershipOf({ ...r, rootPostIds: ['p9'] }, new Map(), new Map())).toEqual({
      rootId: 'root',
      postId: 'p9',
    });
    expect(membershipOf({ ...r, rootPostIds: [] }, new Map(), new Map())).toBeNull();
  });

  it('a loaded parent already decided in the thread vouches for an unknown root', () => {
    const parent = reply('p', 'root', 'root');
    const live = reply('live', 'p', 'root');
    const decided: MembershipMap = new Map([['p', { rootId: 'root', postId: 'p1' }]]);
    expect(membershipOf(live, byIdOf([parent]), decided)).toEqual({ rootId: 'root', postId: 'p1' });
  });

  it('is decided once at first paint: an unknown row stays a plain reply when its root resolves', () => {
    const frozen: MembershipMap = new Map();
    const unknown = reply('r', 'x', 'root');
    freezeMemberships([unknown], new Map(), frozen);
    expect(frozen.get('r')).toBeNull();
    // The root hydrates later: the painted row keeps its look.
    freezeMemberships([{ ...unknown, rootPostIds: ['p1'] }], new Map(), frozen);
    expect(frozen.get('r')).toBeNull();
    // A member stays a member.
    const member = reply('m', 'c', 'c');
    freezeMemberships([card('c'), member], byIdOf([card('c'), member]), frozen);
    expect(frozen.get('m')).toEqual({ rootId: 'c', postId: 'p1' });
  });

  it('a deleted root card turns its members back into quotes (deleted root fallback)', () => {
    const frozen: MembershipMap = new Map([['r', { rootId: 'c', postId: 'p1' }]]);
    expect(renderedMembership('r', frozen, byIdOf([card('c')]))).toEqual({
      rootId: 'c',
      postId: 'p1',
    });
    const tomb = msg('c', { deleted: true });
    expect(renderedMembership('r', frozen, byIdOf([tomb]))).toBeNull();
  });

  it('only a live, top-level card heads a thread', () => {
    expect(isRootCard(card('c'))).toBe(true);
    expect(isRootCard({ ...card('c'), deleted: true })).toBe(false);
    expect(isRootCard({ ...card('c'), reply: { id: 'x', authorUserId: null, preview: '' } })).toBe(
      false,
    );
    expect(isRootCard(msg('plain'))).toBe(false);
  });
});

describe('railPlans (run builder)', () => {
  const member = (rootId: string): ThreadMembership => ({ rootId, postId: 'p1' });
  const members = new Map<string, ThreadMembership>([
    ['a', member('c')],
    ['b', member('c')],
    ['d', member('c')],
    ['e', member('c')],
    ['x', member('other')],
  ]);
  const memberOf = (row: ThreadMessage): ThreadMembership | null => members.get(row.id) ?? null;
  const item = (m: ThreadMessage): RailItem<ThreadMessage> => ({ kind: 'message', message: m });

  it('root card heads its run: root, middle, last', () => {
    const plans = railPlans([item(card('c')), item(msg('a')), item(msg('b'))], memberOf);
    expect(plans.get('c')).toEqual({ role: 'root', chipRoot: null, continues: true });
    expect(plans.get('a')).toEqual({ role: 'middle', chipRoot: null, continues: true });
    expect(plans.get('b')).toEqual({ role: 'last', chipRoot: null, continues: false });
  });

  it('a root card with no member right below draws no rail', () => {
    const plans = railPlans([item(card('c')), item(msg('plain'))], memberOf);
    expect(plans.get('c')).toBeUndefined();
  });

  it('a non-member row ends the run; the next member starts a chip-headed run', () => {
    const plans = railPlans(
      [item(card('c')), item(msg('a')), item(msg('plain')), item(msg('d')), item(msg('e'))],
      memberOf,
    );
    expect(plans.get('a')?.role).toBe('last');
    expect(plans.get('plain') ?? NO_RAIL).toEqual(NO_RAIL);
    expect(plans.get('d')).toEqual({ role: 'middle', chipRoot: 'c', continues: true });
    expect(plans.get('e')).toEqual({ role: 'last', chipRoot: null, continues: false });
  });

  it('a day pill or the unread divider (a break) ends the run', () => {
    const plans = railPlans(
      [item(card('c')), item(msg('a')), { kind: 'break' }, item(msg('b'))],
      memberOf,
    );
    expect(plans.get('a')?.role).toBe('last');
    expect(plans.get('b')).toEqual({ role: 'last', chipRoot: 'c', continues: false });
  });

  it('a member of another thread ends the run too', () => {
    const plans = railPlans([item(msg('a')), item(msg('x')), item(msg('b'))], memberOf);
    expect(plans.get('a')).toEqual({ role: 'last', chipRoot: 'c', continues: false });
    expect(plans.get('x')).toEqual({ role: 'last', chipRoot: 'other', continues: false });
    expect(plans.get('b')).toEqual({ role: 'last', chipRoot: 'c', continues: false });
  });

  it('deleted members stay on the rail (membership is the root, not the content)', () => {
    const tomb = msg('b', { deleted: true });
    const plans = railPlans([item(card('c')), item(msg('a')), item(tomb)], memberOf);
    expect(plans.get('b')?.role).toBe('last');
  });
});

describe('counts', () => {
  it('counts live replies per root; deleted and refused ones are left out, a sending one counts', () => {
    const rows = [
      reply('a', 'c', 'c'),
      { ...reply('b', 'c', 'c'), deleted: true },
      reply('d', 'a', 'c'),
      reply('x', 'o', 'o'),
      { ...reply('f', 'c', 'c'), state: 'failed' as const },
      { ...reply('s', 'c', 'c'), state: 'sending' as const },
    ];
    const counts = localReplyCounts(rows);
    expect(counts.get('c')).toBe(3);
    expect(counts.get('o')).toBe(1);
  });

  it('a live arrival or a catch-up gap fill counts at once', () => {
    const before = localReplyCounts([reply('a', 'c', 'c')]);
    const after = localReplyCounts([
      reply('a', 'c', 'c'),
      reply('gap', 'a', 'c'),
      reply('live', 'c', 'c'),
    ]);
    expect(before.get('c')).toBe(1);
    expect(after.get('c')).toBe(3);
  });

  it('a loaded root counts locally; else the record count plus what changed since', () => {
    expect(threadReplyCount({ rootLoaded: true, local: 4, entry: undefined })).toBe(4);
    expect(threadReplyCount({ rootLoaded: false, local: 2, entry: { count: 7, base: 2 } })).toBe(7);
    // One live arrival after the read.
    expect(threadReplyCount({ rootLoaded: false, local: 3, entry: { count: 7, base: 2 } })).toBe(8);
    expect(threadReplyCount({ rootLoaded: false, local: 3, entry: 'none' })).toBeNull();
    expect(threadReplyCount({ rootLoaded: false, local: 3, entry: undefined })).toBeNull();
  });

  it('labels: hidden at 0, "1 reply", "N replies"', () => {
    expect(replyCountLabel(0)).toBeNull();
    expect(replyCountLabel(null)).toBeNull();
    expect(replyCountLabel(1)).toBe('1 reply');
    expect(replyCountLabel(5)).toBe('5 replies');
  });
});

describe('counts batching', () => {
  afterEach(() => vi.useRealTimers());
  const loaded = new Set(['loadedRoot']);

  it('one call per page: only not-loaded card roots, none while a root still hydrates', () => {
    const page = [
      reply('a', 'x', 'r1'),
      { ...reply('b', 'y', 'r2'), rootPostIds: ['p2'] },
      { ...reply('c', 'z', 'r3'), rootPostIds: [] },
      reply('d', 'loadedRoot', 'loadedRoot'),
      { ...reply('e', 'b', 'r2'), rootPostIds: ['p2'] },
    ];
    // 'a' still waits for its root's hydration: no read yet.
    expect(pageCountRoots(page, loaded, () => false)).toEqual([]);
    const hydrated = page.map((m) => (m.id === 'a' ? { ...m, rootPostIds: ['p1'] } : m));
    expect(pageCountRoots(hydrated, loaded, () => false)).toEqual(['r1', 'r2']);
    expect(pageCountRoots(hydrated, loaded, (id) => id === 'r1')).toEqual(['r2']);
  });

  it('reads the roots in one call, at most 200, never twice', async () => {
    const load = vi.fn<(ids: string[]) => Promise<Result<Map<string, ThreadReplyCount>>>>((ids) =>
      Promise.resolve({ ok: true, data: new Map(ids.map((id) => [id, { count: 3 }])) }),
    );
    const counts = createThreadCounts(load);
    const roots = Array.from({ length: 250 }, (_, i) => `r${i}`);
    await counts.request(roots, () => 1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toHaveLength(200);
    expect(counts.get('r0')).toEqual({ count: 3, base: 1 });
    // Past the 200: not read, so not counted as 0; the next page's read takes them.
    expect(counts.get('r220')).toBeUndefined();
    expect(counts.requested('r220')).toBe(false);
    expect(counts.request(['r0'], () => 0)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    // The next page's read takes the roots left over, in one more call.
    await counts.request(roots, () => 1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toHaveLength(50);
    expect(counts.get('r220')).toEqual({ count: 3, base: 1 });
  });

  it('a row whose root read ran out of time no longer holds the page read back', () => {
    const page = [reply('a', 'x', 'r1'), { ...reply('b', 'y', 'r2'), rootPostIds: ['p2'] }];
    expect(pageCountRoots(page, new Set(), () => false)).toEqual([]);
    expect(
      pageCountRoots(
        page,
        new Set(),
        () => false,
        () => false,
      ),
    ).toEqual(['r2']);
  });

  it('a read that times out settles with no count for good; a late answer is dropped', async () => {
    vi.useFakeTimers();
    const late: { answer?: (r: Result<Map<string, ThreadReplyCount>>) => void } = {};
    const counts = createThreadCounts(
      () =>
        new Promise((resolve) => {
          late.answer = resolve;
        }),
    );
    const done = counts.request(['r1'], () => 0);
    expect(counts.settled('r1')).toBe(false);
    vi.advanceTimersByTime(THREAD_COUNTS_WAIT_MS);
    await done;
    expect(counts.get('r1')).toBe('none');
    late.answer?.({ ok: true, data: new Map([['r1', { count: 9 }]]) });
    await Promise.resolve();
    expect(counts.get('r1')).toBe('none');
    expect(counts.request(['r1'], () => 0)).toBeNull();
  });

  it('a failed read settles with no count too', async () => {
    const counts = createThreadCounts(() =>
      Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } }),
    );
    await counts.request(['r1'], () => 0);
    expect(counts.get('r1')).toBe('none');
  });
});

describe('rowGeometry', () => {
  it('a DM member shifts 14px and ticks into its bubble', () => {
    expect(
      rowGeometry({ role: 'middle', mine: false, isGroup: false, photo: false, selecting: false }),
    ).toEqual({ padLeft: 'pl-[30px]', shift: 14, target: 'bubble', reach: 'w-[15px]' });
  });

  it('a group run head ticks into its photo; a tucked row reaches past the gutter', () => {
    const head = rowGeometry({
      role: 'middle',
      mine: false,
      isGroup: true,
      photo: true,
      selecting: false,
    });
    expect(head).toEqual({ padLeft: 'pl-[30px]', shift: 14, target: 'photo', reach: 'w-[15px]' });
    const tucked = rowGeometry({
      role: 'last',
      mine: false,
      isGroup: true,
      photo: false,
      selecting: false,
    });
    expect(tucked).toEqual({
      padLeft: 'pl-[30px]',
      shift: 14,
      target: 'bubble',
      reach: 'w-[55px]',
    });
  });

  it('a group root card elbows into the card past its photo; the view root shifts 29px', () => {
    expect(
      rowGeometry({ role: 'root', mine: false, isGroup: true, photo: true, selecting: false }),
    ).toEqual({ padLeft: 'pl-[30px]', shift: 14, target: 'bubble', reach: 'w-[55px]' });
    expect(
      rowGeometry({
        role: 'root',
        mine: false,
        isGroup: true,
        photo: true,
        selecting: false,
        viewRoot: true,
      }),
    ).toEqual({ padLeft: 'pl-[45px]', shift: 29, target: 'bubble', reach: 'w-[70px]' });
  });

  it('outgoing rows keep their place and reach across the row in CSS', () => {
    expect(
      rowGeometry({ role: 'middle', mine: true, isGroup: true, photo: false, selecting: false }),
    ).toEqual({ padLeft: 'pl-4', shift: 0, target: 'bubble', reach: OWN_REACH });
  });

  it('a left root card is shifted from its first paint, rail or not; an own one is not', () => {
    expect(
      rowGeometry({
        role: null,
        mine: false,
        isGroup: false,
        photo: false,
        selecting: false,
        rootCard: true,
      }),
    ).toEqual({ padLeft: 'pl-[30px]', shift: 14, target: 'bubble', reach: '' });
    expect(
      rowGeometry({
        role: null,
        mine: true,
        isGroup: false,
        photo: false,
        selecting: false,
        rootCard: true,
      }),
    ).toMatchObject({ padLeft: 'pl-4', shift: 0 });
    expect(
      rowGeometry({
        role: null,
        mine: false,
        isGroup: false,
        photo: false,
        selecting: true,
        rootCard: true,
      }),
    ).toMatchObject({ padLeft: 'pl-4', shift: 0 });
  });

  it('selection removes the rail and the shift', () => {
    expect(
      rowGeometry({ role: 'middle', mine: false, isGroup: true, photo: true, selecting: true }),
    ).toEqual({ padLeft: 'pl-4', shift: 0, target: 'photo', reach: '' });
    expect(
      rowGeometry({ role: null, mine: false, isGroup: false, photo: false, selecting: false }),
    ).toMatchObject({ padLeft: 'pl-4', shift: 0, reach: '' });
  });
});
