import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Result } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import {
  LIVE_WORKSPACE_KEY,
  fanoutTarget,
  sendText,
  setLiveWorkspaceId,
  type ChannelTarget,
  type LiveSendConnection,
  type MessageReaction,
  type ThreadConnection,
} from '@/lib/chat/thread';
import {
  SIGNAL_ACTION,
  TYPING_ACTION,
  sendSignal,
  sendTyping,
  subscribeTyping,
  visibleTypingIds,
  type CreateCmdMessage,
  type TypingConnection,
} from '@/lib/chat/typing';
import {
  ROSTER_ACTION,
  createGroupMemberCache,
  createRosterReloader,
  reloadedFor,
  rosterExt,
  sendRosterSignal,
  shownChannel,
  openChannelAfterRoster,
} from '@/lib/chat/roster-signal';
import { REACTION_RECHECK_CONCURRENCY, rereadReactions, untouchedSince } from '@/lib/chat/catch-up';
import { runSend, type SendFlowDeps } from '@/lib/chat/send-flow';
import { editRunInput } from '@/lib/chat/use-chat-thread';
import { ALL_MENTION, mentionTargets } from '@/lib/chat/mentions';
import {
  applyRosterWithIncoming,
  initialState,
  loadScope,
  type ChatStoreState,
} from '@/lib/chat/chat-store';
import {
  incomingRowAction,
  rememberBodyNames,
  rosterCmdTriggersReload,
} from '@/components/chat/ChatStoreProvider';
import { recencyKey, splitSections, visibleChannels } from '@/components/chat/ChannelList';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ME = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const WS = 'w0000000-0000-4000-8000-000000000001';
const OTHER_WS = 'w0000000-0000-4000-8000-000000000002';
const CHANNEL = 'c0000000-0000-4000-8000-000000000001';
const MSG = 'm0000000-0000-4000-8000-000000000001';
const SYNCED: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

const createCmd: CreateCmdMessage = (options) =>
  ({ ...options }) as unknown as AgoraChat.MessageBody;
const createText = (options: object): AgoraChat.MessageBody =>
  ({ ...options }) as unknown as AgoraChat.MessageBody;

function connection(send = vi.fn().mockResolvedValue({})): LiveSendConnection & {
  send: ReturnType<typeof vi.fn>;
} {
  return { send };
}

function extsOf(send: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return send.mock.calls.map(([m]) => (m as { ext: Record<string, unknown> }).ext);
}

function summary(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: CHANNEL,
    channelType: 'group',
    title: 'Launch',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

afterEach(() => {
  setLiveWorkspaceId(null);
  vi.useRealTimers();
});

describe('H1a only a roster cmd or a verified unknown txt reloads', () => {
  it('unknown-channel typing/read/reaction/mark -> 0 reloads; roster cmd -> 1', async () => {
    vi.useFakeTimers();
    const reload = vi.fn().mockResolvedValue(true);
    const reloader = createRosterReloader({ reload });
    const cmds = [
      { action: TYPING_ACTION, ext: { channelId: CHANNEL } },
      {
        action: SIGNAL_ACTION,
        ext: { sorted_event: 'read', channel_id: CHANNEL, message_id: MSG },
      },
      {
        action: SIGNAL_ACTION,
        ext: { sorted_event: 'reaction', message_id: MSG, emoji: 'x', op: 'add' },
      },
      { action: SIGNAL_ACTION, ext: { sorted_event: 'mark', message_id: MSG } },
    ];
    for (const cmd of cmds) if (rosterCmdTriggersReload(cmd, WS)) reloader.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(0);
    const roster = { action: ROSTER_ACTION, ext: rosterExt(CHANNEL, 'renamed') };
    if (rosterCmdTriggersReload(roster, WS)) reloader.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
    reloader.dispose();
  });

  it('a verified txt for an unknown channel -> hold (1 reload)', () => {
    expect(incomingRowAction({ known: false, foreignWorkspace: false, listReady: true })).toBe(
      'hold',
    );
    expect(incomingRowAction({ known: true, foreignWorkspace: false, listReady: true })).toBe(
      'apply',
    );
  });
});

describe('H1b workspace stamp', () => {
  it('every send path carries sorted_workspace_id (direct and fan-out)', async () => {
    setLiveWorkspaceId(WS);
    const conn = connection();
    const fan = fanoutTarget(CHANNEL, [ME, A, B], ME) as ChannelTarget;
    await sendText({
      connection: conn as unknown as ThreadConnection,
      target: SYNCED,
      text: 'hi',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage: createText,
      liveIds: { sorted_message_id: MSG, sorted_channel_id: CHANNEL },
    });
    await sendText({
      connection: conn as unknown as ThreadConnection,
      target: fan,
      text: 'plain',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage: createText,
    });
    const typing = conn as unknown as TypingConnection;
    await sendSignal({
      connection: typing,
      target: SYNCED,
      createCmd,
      ext: { sorted_event: 'mark' },
    });
    await sendTyping({ connection: typing, target: fan, createCmd, channelId: CHANNEL });
    await sendRosterSignal({
      connection: conn,
      createCmd,
      targets: [SYNCED],
      channelId: CHANNEL,
      kind: 'renamed',
      onError: vi.fn(),
    });
    const exts = extsOf(conn.send);
    expect(exts).toHaveLength(1 + 2 + 1 + 2 + 1);
    expect(exts.every((ext) => ext[LIVE_WORKSPACE_KEY] === WS)).toBe(true);
  });

  it('another workspace -> no reload and no hold; absent -> current behaviour', () => {
    const foreign = {
      action: ROSTER_ACTION,
      ext: { ...rosterExt(CHANNEL, 'created'), [LIVE_WORKSPACE_KEY]: OTHER_WS },
    };
    expect(rosterCmdTriggersReload(foreign, WS)).toBe(false);
    expect(
      rosterCmdTriggersReload({ action: ROSTER_ACTION, ext: rosterExt(CHANNEL, 'created') }, WS),
    ).toBe(true);
    expect(incomingRowAction({ known: false, foreignWorkspace: true, listReady: true })).toBe(
      'drop',
    );
  });
});

describe('H2 new tile paints once, final', () => {
  const incoming = {
    channelId: CHANNEL,
    messageId: MSG,
    senderIsSelf: false,
    text: 'Asha: hello',
    ts: 5_000,
  };

  it('H2a the roster and the held message commit in one transition, never empty', () => {
    const before = initialState();
    const after = applyRosterWithIncoming(before, [summary({})], [incoming]);
    expect(after.roster.map((c) => c.channelId)).toEqual([CHANNEL]);
    expect(after.conversations[CHANNEL]).toMatchObject({
      lastMessageText: 'Asha: hello',
      lastMessageTs: 5_000,
      unread: 1,
    });
  });

  it('H2a a name read that hangs times out at 5s, then one commit', async () => {
    vi.useFakeTimers();
    const commits: ChatStoreState[] = [];
    const run = (async (): Promise<void> => {
      await rememberBodyNames(
        [`hi @[${A}]`],
        () => new Promise<Result<never[]>>(() => {}),
        'ws-h2a',
      );
      commits.push(applyRosterWithIncoming(initialState(), [summary({})], [incoming]));
    })();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(commits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(commits).toHaveLength(1);
    expect(commits[0]?.conversations[CHANNEL]?.lastMessageTs).toBe(5_000);
  });

  const now = Date.parse('2026-09-30T00:00:00.000Z');
  const oldGroup = summary({ channelId: 'g-old', createdAt: '2026-01-01T00:00:00.000Z' });
  const busyGroup = summary({ channelId: 'g-busy', createdAt: '2026-01-02T00:00:00.000Z' });
  const dm = summary({
    channelId: 'd-1',
    channelType: 'dm',
    groupId: null,
    peerUserId: A,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const ts: Record<string, number> = { 'g-busy': now - 60_000, 'd-1': now - 120_000 };
  const lookup = (id: string): ChatStoreState['conversations'][string] | undefined =>
    ts[id] !== undefined
      ? { lastMessageTs: ts[id] ?? 0, lastMessageText: 'x', unread: 0 }
      : undefined;
  const none = (): boolean => false;

  it('H2b a just-created group or DM appears at the top of its section', () => {
    const newGroup = summary({ channelId: 'g-new', createdAt: new Date(now).toISOString() });
    const newDm = summary({
      channelId: 'd-new',
      channelType: 'dm',
      groupId: null,
      peerUserId: B,
      createdAt: new Date(now).toISOString(),
    });
    const list = visibleChannels([oldGroup, busyGroup, dm, newGroup, newDm], lookup, none, '');
    const { groups, people } = splitSections(list);
    expect(groups[0]?.channelId).toBe('g-new');
    expect(people[0]?.channelId).toBe('d-new');
    expect(recencyKey(newGroup, lookup)).toBe(now);
  });

  it('H2c a reload moves no tile whose own key did not change', () => {
    const before = visibleChannels([oldGroup, busyGroup, dm], lookup, none, '').map(
      (c) => c.channelId,
    );
    const renamed = { ...busyGroup, title: 'Renamed' };
    const reloaded = [dm, renamed, oldGroup];
    const after = visibleChannels(reloaded, lookup, none, '').map((c) => c.channelId);
    expect(after).toEqual(before);
  });
});

describe('J1 edit @all in an unsynced group keeps "all"', () => {
  it('the chat type comes from the row, not the fan-out target', () => {
    const body = `heads up @[${ALL_MENTION}]`;
    const fan = fanoutTarget(CHANNEL, [ME, A], ME) as ChannelTarget;
    expect(fan.chatType).toBe('singleChat');
    const input = editRunInput({
      channelId: CHANNEL,
      messageId: MSG,
      body,
      traceId: 't',
      target: fan,
      channelType: 'group',
    });
    expect(input.channelType).toBe('group');
    expect(mentionTargets(body, input.channelType)).toContain(ALL_MENTION);
  });
});

describe('J2 separate budgets', () => {
  it('member read 4.9s + publish 4.9s succeeds', async () => {
    vi.useFakeTimers();
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const d: SendFlowDeps = {
      recordMessage: vi.fn(async () => ({
        ok: true as const,
        row: {
          id: MSG,
          channel_id: CHANNEL,
          workspace_id: WS,
          sender_user_id: ME,
          body: 'hi',
          mentions: null,
          attachment_asset_ids: null,
          shared_post_ids: null,
          shared_brief_ids: null,
          shared_plan_ids: null,
          reply_to_message_id: null,
          thread_root_message_id: null,
          forwarded_from_message_id: null,
          attachment_meta: null,
          agora_event_id: null,
          created_at: '2026-09-30T00:00:00.000+00:00',
          edited_at: null,
          deleted_at: null,
        },
      })),
      beforePublish: () => wait(4_900),
      publishLive: () => wait(4_900),
      onLiveWarning: vi.fn(),
    };
    const pending = runSend(d, {
      id: MSG,
      channelId: CHANNEL,
      currentUserId: ME,
      traceId: 't',
      text: 'hi',
      local: { attachments: [], sharedPostIds: [], reply: null },
    });
    await vi.advanceTimersByTimeAsync(9_800);
    const outcome = await pending;
    expect(outcome.ok && outcome.livePublished).toBe(true);
    expect(d.onLiveWarning).not.toHaveBeenCalled();
  });
});

describe('J3 inbound typing without an Agora target', () => {
  it('an unsynced group shows typing routed by ext channelId', () => {
    const handlers: Array<{ onCmdMessage?: (m: AgoraChat.CmdMsgBody) => void }> = [];
    const conn = {
      addEventHandler: (_id: string, h: { onCmdMessage?: (m: AgoraChat.CmdMsgBody) => void }) =>
        handlers.push(h),
      removeEventHandler: vi.fn(),
      send: vi.fn(),
    } as unknown as TypingConnection;
    const onTypingFrom = vi.fn();
    subscribeTyping({
      connection: conn,
      target: null,
      channelId: CHANNEL,
      currentUserId: ME,
      onTypingFrom,
      onMessageFrom: vi.fn(),
    });
    handlers[0]?.onCmdMessage?.({
      action: TYPING_ACTION,
      chatType: 'singleChat',
      from: toAgoraUsername(A),
      to: toAgoraUsername(ME),
      ext: { channelId: CHANNEL },
    } as unknown as AgoraChat.CmdMsgBody);
    handlers[0]?.onCmdMessage?.({
      action: TYPING_ACTION,
      chatType: 'singleChat',
      from: toAgoraUsername(B),
      to: toAgoraUsername(ME),
      ext: { channelId: 'another-chat' },
    } as unknown as AgoraChat.CmdMsgBody);
    expect(onTypingFrom.mock.calls).toEqual([[A]]);
    expect(
      visibleTypingIds({ ids: [A], isGroup: true, peerUserId: null, memberIds: new Set([ME, A]) }),
    ).toEqual([A]);
  });
});

describe('J6 removed while open', () => {
  const scope = loadScope(WS, ME);
  it('a reload for this scope closes; a stale-scope bump never does', () => {
    expect(reloadedFor(3, { version: 4, scope }, scope)).toBe(true);
    expect(reloadedFor(3, { version: 4, scope: loadScope(OTHER_WS, ME) }, scope)).toBe(false);
    expect(reloadedFor(4, { version: 4, scope }, scope)).toBe(false);
    const open = summary({});
    expect(openChannelAfterRoster(open, [], reloadedFor(3, { version: 4, scope }, scope))).toEqual({
      kind: 'close',
    });
    expect(
      openChannelAfterRoster(
        open,
        [],
        reloadedFor(3, { version: 4, scope: loadScope(OTHER_WS, ME) }, scope),
      ),
    ).toEqual({ kind: 'keep' });
  });
});

describe('J7 header and tile in the same commit', () => {
  it('the header reads the same roster row the tile renders', () => {
    const open = summary({ title: 'Old' });
    const roster = [summary({ title: 'New', avatarUrl: 'https://x/p.png' })];
    const shown = shownChannel(open, roster);
    expect(shown).toBe(roster[0]);
    expect(shownChannel(open, [])).toBe(open);
    expect(shownChannel(null, roster)).toBeNull();
  });
});

describe('J8 reactions catch-up', () => {
  it('at most 3 chunk reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const load = vi.fn(async (chunk: readonly string[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return {
        ok: true as const,
        data: new Map<string, MessageReaction[]>(chunk.map((id) => [id, []])),
      };
    });
    const ids = Array.from({ length: 1_000 }, (_, i) => `id-${i}`);
    const result = await rereadReactions(load, ids);
    expect(load).toHaveBeenCalledTimes(10);
    expect(peak).toBe(REACTION_RECHECK_CONCURRENCY);
    expect(REACTION_RECHECK_CONCURRENCY).toBe(3);
    expect(result.ok && result.data.size).toBe(1_000);
  });

  it('a local toggle after the re-read started is not overwritten', () => {
    const touched = new Map([
      ['a', 2],
      ['b', 5],
    ]);
    expect(untouchedSince(['a', 'b', 'c'], touched, 3)).toEqual(['a', 'c']);
  });
});

describe('J9 cleanup', () => {
  it('clear aborts an in-flight member read and never writes its answer', async () => {
    let seen: AbortSignal | undefined;
    let answer: (r: Result<string[]>) => void = () => {};
    const cache = createGroupMemberCache((_g, signal) => {
      seen = signal;
      return new Promise<Result<string[]>>((r) => (answer = r));
    });
    const pending = cache.get('g1');
    await Promise.resolve();
    cache.clear();
    expect(seen?.aborted).toBe(true);
    answer({ ok: true, data: [A] });
    expect(await pending).toBeNull();
    expect(cache.peek('g1')).toBeUndefined();
  });

  it('an aborted scope sends nothing more and ignores late results', async () => {
    const onError = vi.fn();
    const before = new AbortController();
    before.abort();
    const conn = connection();
    await sendRosterSignal({
      connection: conn,
      createCmd,
      targets: [SYNCED],
      channelId: CHANNEL,
      kind: 'renamed',
      onError,
      signal: before.signal,
    });
    expect(conn.send).not.toHaveBeenCalled();

    const during = new AbortController();
    const failing = connection(
      vi.fn(async () => {
        during.abort();
        throw new Error('late');
      }),
    );
    await sendRosterSignal({
      connection: failing,
      createCmd,
      targets: [SYNCED],
      channelId: CHANNEL,
      kind: 'renamed',
      onError,
      signal: during.signal,
    });
    expect(onError).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  setLiveWorkspaceId(null);
});
