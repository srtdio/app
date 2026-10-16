import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The component's import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node (as ChatStoreProvider.test.tsx does).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyMentionProfileRead,
  applyProfileRead,
  CHAT_UNAVAILABLE_TOAST,
  deepLinkAfterRefresh,
  deepLinkRefreshOutcome,
  deepLinkStep,
  idsToRead,
  initialJumpFor,
  messageParamTarget,
  NO_NAME_READS,
  openMentionDm,
  paintableMessages,
  pendingJumpAfter,
  profileIdsNeeded,
  type NameReads,
} from '@/components/chat/ChatConnected';
import {
  initialJumpDue,
  JUMP_NOT_LOADED_TOAST,
  jumpMiss,
  olderPageAnchorStep,
  profileNameOf,
  renderBodyWithMentions,
} from '@/components/chat/MessageThread';
import {
  READ_TIMEOUT_MS,
  readMentionProfiles,
  withReadTimeout,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import { findInOlderPages } from '@/lib/chat/marks';
import {
  isFormerMember,
  isUnconfirmedMember,
  knownMentionName,
  rememberMentionProfiles,
  rememberMentionRead,
  resetMentionNames,
  resolveMentionText,
  serializeMentions,
} from '@/lib/chat/mentions';
import { previewMentionText, rememberBodyNames } from '@/components/chat/ChatStoreProvider';
import { draftLine } from '@/components/chat/ChannelList';
import { composerBodyFor } from '@/components/chat/Composer';
import { mentionGone } from '@/components/chat/use-channel-members';
import { runEdit } from '@/lib/chat/delete-flow';
import type { ChatMessageRow, ThreadMessage } from '@/lib/chat/thread';
import type { Client, Result } from '@srtdio/rpc';
import { loadOlderMessages } from '@/lib/chat/history';
import { findWithinBudget, JUMP_BUDGET_MS } from '@/lib/chat/use-chat-thread';

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'sender',
    body: '',
    createdAt: '2026-09-22T10:00:00Z',
    time: 0,
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

describe('profileIdsNeeded', () => {
  it('one batch covers senders, the DM peer and every mention (body and quote)', () => {
    const ids = profileIdsNeeded({
      messages: [
        message({ body: `hi @[${ANA}]` }),
        message({ id: 'm2', reply: { id: 'm1', authorUserId: null, preview: `@[${BEN}]` } }),
      ],
      peerUserId: 'peer',
      held: new Map(),
    });
    expect(ids.sort()).toEqual([ANA, BEN, 'peer', 'sender'].sort());
  });

  it('skips ids already held', () => {
    const held = new Map([
      [ANA, {}],
      ['sender', {}],
    ]);
    expect(
      profileIdsNeeded({ messages: [message({ body: `@[${ANA}]` })], peerUserId: null, held }),
    ).toEqual([]);
  });

  it('includes a typing id that is not among the senders', () => {
    const ids = profileIdsNeeded({
      messages: [message({})],
      peerUserId: null,
      held: new Map(),
      typingUserIds: [ANA],
    });
    expect(ids.sort()).toEqual([ANA, 'sender'].sort());
  });

  it('skips a typing id already held', () => {
    const ids = profileIdsNeeded({
      messages: [message({})],
      peerUserId: null,
      held: new Map([[ANA, {}]]),
      typingUserIds: [ANA],
    });
    expect(ids).toEqual(['sender']);
  });

  it('a typing-only id does not hold the first page', () => {
    // The hold is computed from messages and the peer only; typing ids join
    // the read request alone.
    const held = new Map([['sender', {}]]);
    const hold = profileIdsNeeded({ messages: [message({})], peerUserId: null, held });
    const read = profileIdsNeeded({
      messages: [message({})],
      peerUserId: null,
      held,
      typingUserIds: [ANA],
    });
    expect(hold).toEqual([]);
    expect(idsToRead(read, NO_NAME_READS, new Set())).toEqual([ANA]);
  });
});

describe('messageParamTarget', () => {
  it('reads ?channel= with ?message= as the jump target', () => {
    expect(messageParamTarget(new URLSearchParams('channel=c1&message=m9'))).toEqual({
      channelId: 'c1',
      messageId: 'm9',
    });
  });

  it('no message (or no channel) is no jump: the chat opens at the bottom', () => {
    expect(messageParamTarget(new URLSearchParams('channel=c1'))).toBeNull();
    expect(messageParamTarget(new URLSearchParams('message=m9'))).toBeNull();
    expect(messageParamTarget(new URLSearchParams('channel=c1&message='))).toBeNull();
  });
});

describe('openMentionDm', () => {
  it('opens the DM through the existing open-or-create function with a fresh trace', async () => {
    const onOpen = vi.fn();
    const start = vi.fn(async (_p: unknown, open: (id: string) => void) => {
      open('dm-1');
      return null;
    });
    const onFailed = vi.fn();
    await openMentionDm(BEN, { workspaceId: 'w1', start, onOpen, onFailed });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', peerUserId: BEN, traceId: expect.any(String) }),
      onOpen,
    );
    expect(onOpen).toHaveBeenCalledWith('dm-1');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('a failure is reported, never thrown', async () => {
    const onFailed = vi.fn();
    await openMentionDm(BEN, {
      workspaceId: 'w1',
      start: async () => ({ message: 'nope' }),
      onOpen: vi.fn(),
      onFailed,
    });
    expect(onFailed).toHaveBeenCalledWith(expect.any(String), 'nope');
  });
});

// --- fix round 1 -------------------------------------------------------------

const EX = '33333333-3333-4333-8333-333333333333';

type Profiles = Map<string, ChatProfile>;

function profile(userId: string, displayName: string): ChatProfile {
  return { userId, displayName, avatarUrl: null };
}

/** ChatConnected's row gate: a row paints once each name it needs has settled. */
function paint(
  messages: ThreadMessage[],
  profiles: Profiles,
  reads: NameReads,
  painted?: ReadonlySet<string>,
): ThreadMessage[] {
  return paintableMessages(
    messages,
    (id) => profiles.has(id) || knownMentionName('w1', id) !== undefined,
    reads,
    painted,
  );
}

/** One pass of ChatConnected's profile effect: one batched read, folded in. */
async function readOnce(
  messages: ThreadMessage[],
  profiles: Profiles,
  reads: NameReads,
  read: (ids: string[]) => Promise<Result<ChatProfile[]>>,
): Promise<{ asked: string[]; profiles: Profiles; reads: NameReads }> {
  const asked = idsToRead(
    profileIdsNeeded({ messages, peerUserId: null, held: profiles }),
    reads,
    new Set(),
  );
  if (asked.length === 0) return { asked, profiles, reads };
  const result = await read(asked);
  const next = new Map(profiles);
  if (result.ok) {
    for (const p of result.data) next.set(p.userId, p);
    // As the effect does: an asked id the read did not return is confirmed gone.
    rememberMentionRead(
      'w1',
      asked,
      result.data.map((p) => ({ ...p, member: true })),
    );
  }
  return { asked, profiles: next, reads: applyProfileRead(reads, asked, result) };
}

/** A painted row's body as the bubble draws it (peer bubble, tappable mentions). */
function bubbleHtml(message: ThreadMessage, profiles: Profiles): string {
  return renderToStaticMarkup(
    <p>
      {renderBodyWithMentions(message.body, false, {
        nameOf: profileNameOf(profiles, 'w1'),
        viewerUserId: 'me',
        mentions: { peerUserId: null, onOpen: () => {} },
      })}
    </p>,
  );
}

const ok = (data: ChatProfile[]): Result<ChatProfile[]> => ({ ok: true, data });
const failed: Result<ChatProfile[]> = { ok: false, error: { code: 'unknown', message: 'down' } };

describe('F2 live and older-page mentions paint final', () => {
  beforeEach(() => resetMentionNames());
  const firstPage = [message({ id: 'm1', body: 'hi' })];
  const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);

  it('F2 live row with a not-yet-known current member renders "@Name" on first paint', async () => {
    const live = message({ id: 'm2', body: `ping @[${ANA}]` });
    const messages = [...firstPage, live];
    // Before its read settles the row is held, never painted as "@Former member".
    expect(paint(messages, known, NO_NAME_READS).map((m) => m.id)).toEqual(['m1']);
    const read = vi.fn(async () => ok([profile(ANA, 'Ana')]));
    const after = await readOnce(messages, known, NO_NAME_READS, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(after.asked).toEqual([ANA]);
    const painted = paint(messages, after.profiles, after.reads);
    expect(painted.map((m) => m.id)).toEqual(['m1', 'm2']);
    const html = bubbleHtml(live, after.profiles);
    expect(html).toContain('@Ana');
    expect(html).not.toContain('Former member');
  });

  it('F2 older page with a not-yet-known member (body and quote) renders "@Name" on first paint', async () => {
    const older = [
      message({ id: 'o1', body: `for @[${ANA}]` }),
      message({ id: 'o2', reply: { id: 'o1', authorUserId: BEN, preview: `for @[${ANA}]` } }),
    ];
    const messages = [...older, ...firstPage];
    // The first page is already on screen (painted), so the held page never takes it away.
    const onScreen = new Set(['m1']);
    expect(paint(messages, known, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual(['m1']);
    const read = vi.fn(async () => ok([profile(ANA, 'Ana'), profile(BEN, 'Ben')]));
    const after = await readOnce(messages, known, NO_NAME_READS, read);
    // One batched read for the whole page.
    expect(read).toHaveBeenCalledTimes(1);
    expect([...after.asked].sort()).toEqual([ANA, BEN].sort());
    expect(paint(messages, after.profiles, after.reads).map((m) => m.id)).toEqual([
      'o1',
      'o2',
      'm1',
    ]);
    expect(bubbleHtml(older[0] ?? message({}), after.profiles)).toContain('@Ana');
  });

  it('F2 confirmed ex-member renders "@Former member" on first paint and stays', async () => {
    const live = message({ id: 'm2', body: `was @[${EX}]` });
    const messages = [...firstPage, live];
    const after = await readOnce(messages, known, NO_NAME_READS, async () => ok([]));
    expect(after.reads.unknown.has(EX)).toBe(true);
    expect(paint(messages, after.profiles, after.reads).map((m) => m.id)).toEqual(['m1', 'm2']);
    const html = bubbleHtml(live, after.profiles);
    expect(html).toContain('@Former member');
    expect(html).not.toContain('<button');
    // Never read again: no swap later.
    expect(
      idsToRead(
        profileIdsNeeded({ messages, peerUserId: null, held: after.profiles }),
        after.reads,
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe('F3 a failed profile read is not cached as unknown', () => {
  beforeEach(() => resetMentionNames());

  it('F3 first read fails, second succeeds, name appears; failure not memoized', async () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const first = message({ id: 'm1', body: `hey @[${ANA}]` });
    const one = await readOnce([first], known, NO_NAME_READS, async () => failed);
    expect(one.asked).toEqual([ANA]);
    expect(one.reads.unknown.has(ANA)).toBe(false);
    expect(one.reads.failed.has(ANA)).toBe(true);
    // Unresolved after a failure: the row paints, the mention is inert "@Former member".
    expect(paint([first], one.profiles, one.reads).map((m) => m.id)).toEqual(['m1']);
    const inert = bubbleHtml(first, one.profiles);
    // A current member not read yet (or a failed read) is never labelled "Former member".
    expect(inert).not.toContain('Former member');
    expect(inert).not.toContain('<button');
    // No retry loop on its own.
    expect(
      idsToRead(
        profileIdsNeeded({ messages: [first], peerUserId: null, held: one.profiles }),
        one.reads,
        new Set(),
      ),
    ).toEqual([]);
    // The next profile read (a live row) retries it alongside the new id.
    const next = message({ id: 'm2', body: `and @[${BEN}]` });
    const read = vi.fn(async (ids: string[]) =>
      ok(ids.map((id) => profile(id, id === ANA ? 'Ana' : 'Ben'))),
    );
    const two = await readOnce([first, next], one.profiles, one.reads, read);
    expect([...two.asked].sort()).toEqual([ANA, BEN].sort());
    expect(two.reads.failed.size).toBe(0);
    expect(bubbleHtml(first, two.profiles)).toContain('@Ana');
  });
});

function channel(channelId: string): ChannelSummary {
  return {
    channelId,
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

describe('F6 Activity jump lands on the mention', () => {
  const roster = [channel('c1')];

  it('F6 link to a message on the first page lands on it', () => {
    const step = deepLinkStep(new URLSearchParams('channel=c1&message=m1'), roster);
    expect(step.open?.channelId).toBe('c1');
    const target = initialJumpFor(step.jump, 'c1');
    expect(target).toBe('m1');
    // Not while the skeleton holds the first page (no row to reveal yet)...
    expect(initialJumpDue({ messageId: target, done: false, bodyLoading: true })).toBe(false);
    // ...then once the rows are on screen, with the row painted.
    expect(initialJumpDue({ messageId: target, done: false, bodyLoading: false })).toBe(true);
    const page = [message({ id: 'm1' }), message({ id: 'm2' })];
    expect(paint(page, new Map(), NO_NAME_READS).some((m) => m.id === target)).toBe(true);
  });

  it('F6 link to a message needing older pages lands on it (ensureLoaded path)', async () => {
    const row = (id: string, at: string): ChatMessageRow =>
      ({ id, created_at: at }) as ChatMessageRow;
    const pages = [[row('p2', '2026-09-02T00:00:00Z')], [row('target', '2026-09-01T00:00:00Z')]];
    let loaded: string[] = ['m1'];
    const outcome = await findInOlderPages({
      start: { createdAt: '2026-09-03T00:00:00Z', id: 'm1' },
      targetId: 'target',
      loadPage: async () => ({
        ok: true,
        data: { rows: pages.shift() ?? [], hasMore: pages.length > 0 },
      }),
      onPage: (rows) => {
        loaded = [...rows.map((r) => r.id), ...loaded];
      },
    });
    expect(outcome).toBe('found');
    const thread = loaded.map((id) => message({ id }));
    expect(paint(thread, new Map(), NO_NAME_READS).some((m) => m.id === 'target')).toBe(true);
  });

  it('F6 leave and reopen: no second jump', () => {
    let pending = deepLinkStep(new URLSearchParams('channel=c1&message=m1'), roster).jump;
    expect(initialJumpFor(pending, 'c1')).toBe('m1');
    // The thread takes it (onInitialJumpTaken): the pending jump is cleared.
    pending = null;
    expect(initialJumpFor(pending, 'c1')).toBeNull();
    expect(initialJumpDue({ messageId: null, done: false, bodyLoading: false })).toBe(false);
  });

  it('F6 unknown channel: toast, stay on the chat list', () => {
    const step = deepLinkStep(new URLSearchParams('channel=gone&message=m1'), roster);
    expect(step).toEqual({ open: null, jump: null, unavailable: true });
    expect(CHAT_UNAVAILABLE_TOAST).toBe("That chat isn't available");
  });
});

// --- fix round 2 -------------------------------------------------------------

describe('H1 hanging or throwing name reads settle as failed', () => {
  beforeEach(() => resetMentionNames());

  it('H1 hanging profile read paints the held row after the 5s timeout', async () => {
    vi.useFakeTimers();
    try {
      const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
      const live = message({ id: 'm2', body: `ping @[${ANA}]` });
      const messages = [message({ id: 'm1', body: 'hi' }), live];
      expect(paint(messages, known, NO_NAME_READS).map((m) => m.id)).toEqual(['m1']);
      const asked = idsToRead(
        profileIdsNeeded({ messages, peerUserId: null, held: known }),
        NO_NAME_READS,
        new Set(),
      );
      const pending = withReadTimeout<ChatProfile[]>(() => new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      const result = await pending;
      expect(result.ok).toBe(false);
      const reads = applyProfileRead(NO_NAME_READS, asked, result);
      expect(paint(messages, known, reads).map((m) => m.id)).toEqual(['m1', 'm2']);
      const html = bubbleHtml(live, known);
      // A current member not read yet (or a failed read) is never labelled "Former member".
      expect(html).not.toContain('Former member');
      expect(html).not.toContain('<button');
    } finally {
      vi.useRealTimers();
    }
  });

  it('H1 thrown rejection is handled as a failed read, never unhandled', async () => {
    const result = await withReadTimeout<ChatProfile[]>(() => Promise.reject(new Error('boom')));
    expect(result.ok).toBe(false);
    const sync = await withReadTimeout<ChatProfile[]>(() => {
      throw new Error('sync boom');
    });
    expect(sync.ok).toBe(false);
    const reads = applyProfileRead(NO_NAME_READS, [ANA], result);
    expect(reads.failed.has(ANA)).toBe(true);
  });
});

describe('H3 own sends are never held', () => {
  it('H3 own reply quoting a row with an unresolved author paints on first render', () => {
    const own = message({
      id: 'local-1',
      senderUserId: 'me',
      mine: true,
      state: 'sending',
      body: `re @[${BEN}]`,
      reply: { id: 'm1', authorUserId: ANA, preview: 'quoted' },
    });
    const painted = paint([message({ id: 'm1', body: 'hi' }), own], new Map(), NO_NAME_READS);
    expect(painted.map((m) => m.id)).toEqual(['m1', 'local-1']);
    const html = bubbleHtml(own, new Map());
    // A current member not read yet (or a failed read) is never labelled "Former member".
    expect(html).not.toContain('Former member');
    expect(html).not.toContain('<button');
  });
});

describe('J1 an own send releases the rows held ahead of it', () => {
  beforeEach(() => resetMentionNames());

  it('J1 peer row N held, own send N+1: rendered order is N then N+1 on first paint of N+1', () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const n = message({ id: 'n', body: `for @[${ANA}]` });
    const onScreen = new Set<string>();
    expect(paint([n], known, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([]);
    const own = message({
      id: 'local-1',
      senderUserId: 'me',
      mine: true,
      state: 'sending',
      body: 'mine',
    });
    expect(paint([n, own], known, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([
      'n',
      'local-1',
    ]);
    // The released row draws its unresolved name inert.
    const html = bubbleHtml(n, known);
    // A current member not read yet (or a failed read) is never labelled "Former member".
    expect(html).not.toContain('Former member');
    expect(html).not.toContain('<button');
  });
});

describe('J6 an older page releases as one batch without moving the viewport', () => {
  beforeEach(() => resetMentionNames());

  it('J6 older page held then released keeps the anchor row at the same offset', () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const anchorRow = message({ id: 'p1', body: 'on screen' });
    const o1 = message({ id: 'o1', body: 'resolved' });
    const o2 = message({ id: 'o2', body: `for @[${ANA}]` });
    const onScreen = new Set(['p1']);
    // Held: no row of the page paints alone, not even the resolved one.
    expect(paint([o1, o2, anchorRow], known, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([
      'p1',
    ]);
    // A layout model: the anchor row sits below whatever is prepended above it;
    // its offset in the viewport is rowTop - scrollTop.
    let scrollTop = 0;
    let scrollHeight = 1_000;
    let rowTop = 0;
    const offset0 = rowTop - scrollTop;
    let anchor: number | null = scrollHeight;
    // A live row lands below while the page is held: no scroll, the anchor re-bases.
    scrollHeight += 80;
    let step = olderPageAnchorStep({ anchorHeight: anchor, prepended: false, scrollHeight });
    expect(step.scrollBy).toBe(0);
    anchor = step.anchorHeight;
    expect(anchor).toBe(1_080);
    // Released: the whole page paints together, and the compensation lands in that render.
    const released: Profiles = new Map([...known, [ANA, profile(ANA, 'Ana')]]);
    expect(paint([o1, o2, anchorRow], released, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([
      'o1',
      'o2',
      'p1',
    ]);
    const pageHeight = 400;
    scrollHeight += pageHeight;
    rowTop += pageHeight;
    step = olderPageAnchorStep({ anchorHeight: anchor ?? 0, prepended: true, scrollHeight });
    expect(step).toEqual({ scrollBy: pageHeight, anchorHeight: null });
    scrollTop += step.scrollBy;
    expect(rowTop - scrollTop).toBe(offset0);
  });
});

describe('H4 a held row keeps later rows behind it', () => {
  beforeEach(() => resetMentionNames());

  it('H4 held row N, arriving row N+1: neither paints until N releases, then both in order', () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const first = message({ id: 'm1', body: 'hi' });
    const n = message({ id: 'n', body: `for @[${ANA}]` });
    const next = message({ id: 'n1', body: 'plain' });
    const onScreen = new Set(['m1']);
    expect(paint([first, n, next], known, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([
      'm1',
    ]);
    const released: Profiles = new Map([...known, [ANA, profile(ANA, 'Ana')]]);
    expect(paint([first, n, next], released, NO_NAME_READS, onScreen).map((m) => m.id)).toEqual([
      'm1',
      'n',
      'n1',
    ]);
  });
});

describe('H5 a chat switch never re-holds painted rows', () => {
  beforeEach(() => resetMentionNames());

  it('H5 painted row with a failed id stays painted across channel switch and back', async () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const row = message({ id: 'm1', body: `hey @[${ANA}]` });
    const one = await readOnce([row], known, NO_NAME_READS, async () => failed);
    const shown = paint([row], one.profiles, one.reads);
    expect(shown.map((m) => m.id)).toEqual(['m1']);
    const onScreen = new Set(shown.map((m) => m.id));
    // Switch away and back: the failed id is retried in place, still failed meanwhile.
    const retry = idsToRead(
      profileIdsNeeded({ messages: [row], peerUserId: null, held: one.profiles }),
      one.reads,
      new Set(),
      true,
    );
    expect(retry).toEqual([ANA]);
    expect(one.reads.failed.has(ANA)).toBe(true);
    expect(paint([row], one.profiles, one.reads, onScreen).map((m) => m.id)).toEqual(['m1']);
    // The retry answers: the same row updates in place with the name.
    const after = applyProfileRead(one.reads, retry, ok([profile(ANA, 'Ana')]));
    const withName: Profiles = new Map([...one.profiles, [ANA, profile(ANA, 'Ana')]]);
    expect(paint([row], withName, after, onScreen).map((m) => m.id)).toEqual(['m1']);
    expect(bubbleHtml(row, withName)).toContain('@Ana');
  });
});

describe('H6 a pending jump belongs to its chat', () => {
  it('H6 open link to chat A, switch to B before load, reopen A later: no jump', () => {
    const roster = [channel('A'), channel('B')];
    let pending = deepLinkStep(new URLSearchParams('channel=A&message=m9'), roster).jump;
    pending = pendingJumpAfter(pending, 'A');
    expect(initialJumpFor(pending, 'A')).toBe('m9');
    // Switched to B before the jump ran.
    pending = pendingJumpAfter(pending, 'B');
    expect(pending).toBeNull();
    // Reopen A later.
    pending = pendingJumpAfter(pending, 'A');
    expect(initialJumpFor(pending, 'A')).toBeNull();
    // Closing drops it too, and an unknown-channel link carries none.
    expect(pendingJumpAfter({ channelId: 'A', messageId: 'm9' }, null)).toBeNull();
    expect(deepLinkStep(new URLSearchParams('channel=gone&message=m1'), roster).jump).toBeNull();
  });
});

describe('H7 a deep link re-reads the chat list before saying unavailable', () => {
  it('H7 missing from the snapshot but present after refresh opens normally', async () => {
    const reload = vi.fn(async () => [channel('c1'), channel('new')]);
    const step = await deepLinkAfterRefresh(
      new URLSearchParams('channel=new&message=m1'),
      [channel('c1')],
      reload,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(step.open?.channelId).toBe('new');
    expect(step.jump).toEqual({ channelId: 'new', messageId: 'm1' });
    expect(step.unavailable).toBe(false);
  });

  it('H7 truly absent (or a failed refresh) toasts', async () => {
    const reload = vi.fn(async () => [channel('c1')]);
    const params = new URLSearchParams('channel=gone');
    const step = await deepLinkAfterRefresh(params, [channel('c1')], reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(step).toEqual({ open: null, jump: null, unavailable: true });
    const failedReload = await deepLinkAfterRefresh(params, [], async () => null);
    expect(failedReload.unavailable).toBe(true);
    // Present in the snapshot: no refresh at all.
    const noReload = vi.fn(async () => []);
    await deepLinkAfterRefresh(new URLSearchParams('channel=c1'), [channel('c1')], noReload);
    expect(noReload).not.toHaveBeenCalled();
  });
});

describe('J4 a hanging deep-link refresh times out as absent', () => {
  it('J4 hanging refresh toasts after timeout', async () => {
    vi.useFakeTimers();
    try {
      const params = new URLSearchParams('channel=new');
      let step: Awaited<ReturnType<typeof deepLinkAfterRefresh>> | null = null;
      void deepLinkAfterRefresh(params, [channel('c1')], () => new Promise(() => undefined)).then(
        (next) => {
          step = next;
        },
      );
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
      expect(step).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(step).toEqual({ open: null, jump: null, unavailable: true });
      const here = { mounted: true, workspaceId: 'w1', channel: 'new' };
      expect(deepLinkRefreshOutcome(step ?? deepLinkStep(params, []), here, here)).toBe('toast');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('J5 a deep-link refresh applies only on the same page', () => {
  it('J5 workspace switch during refresh: no open, no toast', () => {
    const started = { mounted: true, workspaceId: 'w1', channel: 'new' };
    const found = deepLinkStep(new URLSearchParams('channel=new'), [channel('new')]);
    const absent = deepLinkStep(new URLSearchParams('channel=new'), []);
    const switched = { ...started, workspaceId: 'w2' };
    expect(deepLinkRefreshOutcome(found, started, switched)).toBe('discard');
    expect(deepLinkRefreshOutcome(absent, started, switched)).toBe('discard');
    // Unmounted, or a different ?channel=, discards too.
    expect(deepLinkRefreshOutcome(absent, started, { ...started, mounted: false })).toBe('discard');
    expect(deepLinkRefreshOutcome(found, started, { ...started, channel: 'other' })).toBe(
      'discard',
    );
    // Unchanged: opens when found, toasts when absent.
    expect(deepLinkRefreshOutcome(found, started, started)).toBe('open');
    expect(deepLinkRefreshOutcome(absent, started, started)).toBe('toast');
  });
});

// --- fix round 4 -------------------------------------------------------------

describe('B2 the jump runs under one 5s budget', () => {
  const start = { createdAt: '2026-09-03T00:00:00Z', id: 'm1' };

  /** A chat_messages query whose read hangs until its abort signal fires. */
  function hangingClient(): { client: Client; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const query = {
      select: () => query,
      eq: () => query,
      or: () => query,
      order: () => query,
      limit: () => query,
      abortSignal: (signal: AbortSignal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { message: 'AbortError: aborted' } }),
          );
        });
      },
    };
    return { client: { from: () => query } as unknown as Client, signals };
  }

  it('B2 hanging older-page read during a jump ends within 5s with spinner off, pending cleared, toast shown', async () => {
    vi.useFakeTimers();
    try {
      const { client, signals } = hangingClient();
      let loadingOlder = true;
      const onPage = vi.fn();
      const pending = findWithinBudget({
        start,
        targetId: 'target',
        loadPage: (cursor, signal) => loadOlderMessages(client, 'c1', cursor, signal),
        onPage,
        onDone: () => {
          loadingOlder = false;
        },
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(JUMP_BUDGET_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      expect(JUMP_BUDGET_MS).toBe(5_000);
      expect(outcome).toBe('error');
      // The hung request was cancelled through .abortSignal and the spinner is off.
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(loadingOlder).toBe(false);
      expect(onPage).not.toHaveBeenCalled();
      // The thread clears the pending target, gives the bottom back and toasts.
      expect(jumpMiss(outcome, true)).toEqual({ stick: true, toast: JUMP_NOT_LOADED_TOAST });
      expect(jumpMiss(outcome, false)).toEqual({ stick: false, toast: JUMP_NOT_LOADED_TOAST });
      // The deep link's pending jump was already dropped when the thread took it.
      expect(initialJumpFor(null, 'c1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B2 slow pages share the one budget: the whole jump still ends at 5s', async () => {
    vi.useFakeTimers();
    try {
      const row = (id: string, at: string): ChatMessageRow =>
        ({ id, created_at: at }) as ChatMessageRow;
      let n = 0;
      let done = false;
      const pending = findWithinBudget({
        start,
        targetId: 'target',
        loadPage: () =>
          new Promise((resolve) => {
            n += 1;
            const page = row(`p${n}`, `2026-09-02T00:00:0${n}Z`);
            setTimeout(() => resolve({ ok: true, data: { rows: [page], hasMore: true } }), 3_000);
          }),
        onPage: vi.fn(),
        onDone: () => {
          done = true;
        },
      });
      await vi.advanceTimersByTimeAsync(JUMP_BUDGET_MS);
      expect(await pending).toBe('error');
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('B2 normal jump unchanged: pages in, found, no toast', async () => {
    const row = (id: string, at: string): ChatMessageRow =>
      ({ id, created_at: at }) as ChatMessageRow;
    const pages = [[row('p2', '2026-09-02T00:00:00Z')], [row('target', '2026-09-01T00:00:00Z')]];
    const onDone = vi.fn();
    const seen: string[] = [];
    const signals: AbortSignal[] = [];
    const outcome = await findWithinBudget({
      start,
      targetId: 'target',
      loadPage: async (_cursor, signal) => {
        signals.push(signal);
        return { ok: true, data: { rows: pages.shift() ?? [], hasMore: pages.length > 0 } };
      },
      onPage: (rows) => seen.push(...rows.map((r) => r.id)),
      onDone,
    });
    expect(outcome).toBe('found');
    expect(seen).toEqual(['p2', 'target']);
    expect(onDone).toHaveBeenCalledWith(false);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    expect(jumpMiss(outcome, true)).toBeNull();
  });
});

describe('B1 a readable profile is not membership', () => {
  beforeEach(() => resetMentionNames());

  /** users returns every profile (RLS lets ex-members be read); workspace_members only the active. */
  function membersClient(active: string[]): { client: Client; reads: string[] } {
    const reads: string[] = [];
    const users = [profileRow(ANA, 'Ana'), profileRow(EX, 'Eve')];
    const client = {
      from: (table: string) => {
        const calls: string[] = [];
        const query = {
          select: () => query,
          eq: () => query,
          is: () => query,
          in: (col: string, ids: string[]) => {
            calls.push(`${col} IN ${ids.join(',')}`);
            return query;
          },
          abortSignal: () => query,
          then: (resolve: (value: unknown) => unknown) => {
            reads.push(`${table}: ${calls.join(' ')}`);
            const data =
              table === 'users' ? users : active.map((id) => ({ user_id: id, role: 'client' }));
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return query;
      },
    };
    return { client: client as unknown as Client, reads };
  }

  function profileRow(id: string, name: string): Record<string, unknown> {
    return { id, display_name: name, avatar_url: null };
  }

  it('B1 removed member with a readable profile renders "@Former member", is not tappable and drops from p_mentions on edit; active member unchanged', async () => {
    const { client, reads } = membersClient([ANA]);
    const result = await readMentionProfiles(client, { workspaceId: 'w1', userIds: [ANA, EX] });
    // One batched pass: one users IN and one workspace_members IN, no per-id read.
    expect(reads).toEqual([
      `users: id IN ${ANA},${EX}`,
      `workspace_members: user_id IN ${ANA},${EX}`,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((p) => [p.displayName, p.member])).toEqual([
      ['Ana', true],
      ['Eve', false],
    ]);
    // What ChatConnected's profile effect does with the read.
    rememberMentionProfiles('w1', result.data);
    const profiles: Profiles = new Map(result.data.map((p) => [p.userId, p]));
    expect(isFormerMember('w1', EX)).toBe(true);

    const body = `hi @[${ANA}] and @[${EX}]`;
    const row = message({ id: 'm2', body });
    // Paints at once (settled), never held.
    expect(paint([row], profiles, applyProfileRead(NO_NAME_READS, [ANA, EX], result))).toEqual([
      row,
    ]);
    // Bubble: Ana is a tappable "@Ana"; the ex-member is inert "@Former member".
    const html = bubbleHtml(row, profiles);
    expect(html).toContain('@Ana');
    expect(html).toContain('@Former member');
    expect(html).not.toContain('Eve');
    expect(html.match(/<button/g)).toHaveLength(1);
    // Copy, list preview, draft line.
    expect(resolveMentionText(body, profileNameOf(profiles, 'w1'))).toBe(
      'hi @Ana and @Former member',
    );
    expect(previewMentionText(body, 'w1')).toBe('hi @Ana and @Former member');
    expect(draftLine(body, 'w1')).toBe('hi @Ana and @Former member');

    // Edit box: the ex-member shows "@Former member" and drops on save, even
    // when the chat's member read failed (the profile read already settled it).
    for (const load of [{ ok: true as const, members: [] }, { ok: false as const }]) {
      const gone = mentionGone(load, 'me', 'w1');
      const shown = composerBodyFor(
        { text: body, caret: body.length },
        true,
        profileNameOf(profiles, 'w1'),
        gone,
      );
      expect(shown.text).toBe('hi @Ana and @Former member');
      const saved = serializeMentions(shown.text, shown.picks);
      const rpc = vi.fn(() => ({
        abortSignal: () =>
          Promise.resolve({ data: { id: 'm2', body: saved, edited_at: 'now' }, error: null }),
      }));
      const edited = await runEdit(
        {
          client: { rpc } as unknown as Client,
          applyLocal: () => undefined,
          signal: undefined,
          onSignalFailed: () => undefined,
        },
        { channelId: 'c1', messageId: 'm2', body: saved, traceId: 't', channelType: 'group' },
      );
      expect(edited.ok).toBe(true);
      const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
      expect(args.p_mentions).toEqual([ANA]);
    }
  });

  it('B1 a failed profile read keeps the existing behaviour: kept, inert, not marked former', async () => {
    const reads = applyProfileRead(NO_NAME_READS, [EX], failed);
    expect(reads.failed.has(EX)).toBe(true);
    expect(isFormerMember('w1', EX)).toBe(false);
    expect(mentionGone({ ok: false }, 'me', 'w1')(EX)).toBe(false);
  });
});

/**
 * A client whose users read returns the given profiles and whose
 * workspace_members read answers per workspace (eq workspace_id): the active
 * ids there, an error ('fail') or never ('hang').
 */
function perWorkspaceClient(
  users: Record<string, unknown>[],
  members: Record<string, string[] | 'fail' | 'hang'>,
): Client {
  return {
    from: (table: string) => {
      let workspaceId = '';
      const query = {
        select: () => query,
        eq: (col: string, value: string) => {
          if (col === 'workspace_id') workspaceId = value;
          return query;
        },
        is: () => query,
        in: () => query,
        abortSignal: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'users') return Promise.resolve({ data: users, error: null }).then(resolve);
          const answer = members[workspaceId] ?? [];
          if (answer === 'hang') return new Promise(() => undefined);
          if (answer === 'fail') {
            return Promise.resolve({ data: null, error: { message: 'down' } }).then(resolve);
          }
          const data = answer.map((id) => ({ user_id: id, role: 'client' }));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as Client;
}

/** A body's bubble as drawn in one workspace's thread (peer bubble, tappable mentions). */
function bubbleIn(body: string, profiles: Profiles, workspaceId: string): string {
  return renderToStaticMarkup(
    <p>
      {renderBodyWithMentions(body, false, {
        nameOf: profileNameOf(profiles, workspaceId),
        viewerUserId: 'me',
        mentions: { peerUserId: null, onOpen: () => {} },
      })}
    </p>,
  );
}

describe('W1 mention state is per workspace', () => {
  beforeEach(() => resetMentionNames());

  it('W1 active in A, removed from B: B reads "@Former member" everywhere, A keeps the name, A->B->A re-reads nothing wrongly', async () => {
    const client = perWorkspaceClient([{ id: ANA, display_name: 'Ana', avatar_url: null }], {
      wa: [ANA],
      wb: [],
    });
    const body = `hi @[${ANA}]`;
    // A then B, each through its own read and its own registry.
    const inA = await readMentionProfiles(client, { workspaceId: 'wa', userIds: [ANA] });
    const inB = await readMentionProfiles(client, { workspaceId: 'wb', userIds: [ANA] });
    if (!inA.ok || !inB.ok) throw new Error('reads failed');
    rememberMentionProfiles('wa', inA.data);
    rememberMentionProfiles('wb', inB.data);
    const profilesA: Profiles = new Map(inA.data.map((p) => [p.userId, p]));
    const profilesB: Profiles = new Map(inB.data.map((p) => [p.userId, p]));

    // B: list preview, draft line, live line and thread all read "@Former member".
    expect(previewMentionText(body, 'wb')).toBe('hi @Former member');
    expect(draftLine(body, 'wb')).toBe('hi @Former member');
    const bHtml = bubbleIn(body, profilesB, 'wb');
    expect(bHtml).toContain('@Former member');
    expect(bHtml).not.toContain('<button');
    expect(mentionGone(null, 'me', 'wb')(ANA)).toBe(true);

    // A: the name stays, tappable; B's former flag never drops or hides them here.
    expect(previewMentionText(body, 'wa')).toBe('hi @Ana');
    expect(draftLine(body, 'wa')).toBe('hi @Ana');
    const aHtml = bubbleIn(body, profilesA, 'wa');
    expect(aHtml).toContain('@Ana');
    expect(aHtml).toContain('<button');
    expect(isFormerMember('wa', ANA)).toBe(false);
    expect(mentionGone(null, 'me', 'wa')(ANA)).toBe(false);
    expect(mentionGone({ ok: false }, 'me', 'wa')(ANA)).toBe(false);

    // Switching A -> B -> A: A's known name needs no read; B re-reads its own
    // unknown (former) id, and its answer never leaks into A.
    const readerFor = (workspaceId: string) =>
      vi.fn(async (ids: string[], signal?: AbortSignal) =>
        readMentionProfiles(client, {
          workspaceId,
          userIds: ids,
          ...(signal !== undefined ? { signal } : {}),
        }),
      );
    const readA = readerFor('wa');
    const readB = readerFor('wb');
    await rememberBodyNames([body], readA, 'wa');
    expect(readA).not.toHaveBeenCalled();
    await rememberBodyNames([body], readB, 'wb');
    expect(readB).toHaveBeenCalledTimes(1);
    expect(previewMentionText(body, 'wb')).toBe('hi @Former member');
    await rememberBodyNames([body], readA, 'wa');
    expect(readA).not.toHaveBeenCalled();
    expect(previewMentionText(body, 'wa')).toBe('hi @Ana');
    // A workspace never read knows nothing from A or B.
    expect(previewMentionText(body, 'wc')).toBe('hi @Former member');
    expect(isFormerMember('wc', ANA)).toBe(false);
  });
});

describe('W4 a failed membership half keeps the profiles', () => {
  beforeEach(() => resetMentionNames());

  const users = [
    { id: BEN, display_name: 'Ben', avatar_url: 'https://cdn.example/ben.png' },
    { id: ANA, display_name: 'Ana', avatar_url: null },
  ];

  for (const members of ['fail', 'hang'] as const) {
    it(`W4 members read ${members === 'fail' ? 'fails' : 'times out'}, users read succeeds: sender name/avatar shown, mentions keep failed-read behaviour`, async () => {
      vi.useFakeTimers();
      try {
        const client = perWorkspaceClient(users, { w1: members });
        const ids = [BEN, ANA];
        const pending = readMentionProfiles(client, {
          workspaceId: 'w1',
          userIds: ids,
          timeoutMs: READ_TIMEOUT_MS,
        });
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
        const result = await pending;
        // Not a failed read: the profiles come back, membership unknown.
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.map((p) => p.member)).toEqual([null, null]);

        // What ChatConnected's profile effect does with it.
        rememberMentionProfiles('w1', result.data);
        const profiles: Profiles = new Map(result.data.map((p) => [p.userId, p]));
        const reads = applyMentionProfileRead(NO_NAME_READS, ids, result);

        // The sender's name and avatar are stored as before.
        expect(profiles.get(BEN)?.displayName).toBe('Ben');
        expect(profiles.get(BEN)?.avatarUrl).toBe('https://cdn.example/ben.png');

        // Mentions: failed (retried), never unknown, nobody marked former, no drops.
        expect([...reads.failed].sort()).toEqual([...ids].sort());
        expect(reads.unknown.size).toBe(0);
        expect(isFormerMember('w1', ANA)).toBe(false);
        expect(isUnconfirmedMember('w1', ANA)).toBe(true);
        expect(mentionGone({ ok: false }, 'me', 'w1')(ANA)).toBe(false);
        const row = message({ id: 'w4', body: `ping @[${ANA}]` });
        expect(paint([row], profiles, reads)).toEqual([row]);
        const html = bubbleIn(row.body, profiles, 'w1');
        // A current member not read yet (or a failed read) is never labelled "Former member".
        expect(html).not.toContain('Former member');
        expect(html).not.toContain('<button');
        // The composer keeps the mention and still sends it.
        const shown = composerBodyFor(
          { text: row.body, caret: row.body.length },
          true,
          profileNameOf(profiles, 'w1'),
          mentionGone({ ok: false }, 'me', 'w1'),
        );
        expect(serializeMentions(shown.text, shown.picks)).toBe(`ping @[${ANA}]`);

        // A later read that confirms membership names them again.
        rememberMentionProfiles('w1', [{ userId: ANA, displayName: 'Ana', member: true }]);
        expect(bubbleIn(row.body, profiles, 'w1')).toContain('@Ana');
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
