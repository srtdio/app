import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The chat store's import graph pulls the browser agora-chat SDK; never in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Client } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { shapeChannelSummaries } from '@/lib/chat-reads';
import {
  canSaveToNotes,
  createNotesEnsurer,
  ensureNotesChannel,
  isNotesChannelId,
  liveClientFor,
  notesChannelId,
  notesSummary,
  NOTES_TITLE,
  saveToNotesEntry,
  waitForNotes,
  withNotesFirst,
} from '@/lib/chat/notes';
import {
  readSavedSources,
  SAVED_MESSAGE_LABEL,
  savedFromLine,
  savedSourceIds,
} from '@/lib/chat/saved-from';
import {
  createSearchRunner,
  searchArgs,
  toggleSearchKind,
  type SearchPageFetch,
} from '@/lib/chat/search';
import { targetFromSummary, type ThreadMessage } from '@/lib/chat/thread';
import { resolveLiveTarget } from '@/lib/chat/roster-signal';
import { runSend } from '@/lib/chat/send-flow';
import { mentionTargets } from '@/lib/chat/mentions';
import { windowFocusTrigger } from '@/lib/chat/catch-up';
import { deleteSelectionBlock, forwardPickerChannels } from '@/lib/chat/forward';
import { messageMenuItems, ownMessageActions } from '@/components/chat/MessageActionMenu';
import { channelHasClient, draftTileEnabled, trayTiles } from '@/components/chat/ComposerTray';
import { ThreadHeaderIdentity, threadStripSlot } from '@/components/chat/MessageThread';
import { channelListContent, showSearchResults } from '@/components/chat/ChannelList';

const WS = '0190a000-0000-7000-8000-00000000a001';
const WS2 = '0190a000-0000-7000-8000-00000000a002';
const ME = '0190a000-0000-7000-8000-000000000001';
const PEER = '0190a000-0000-7000-8000-000000000002';
const NOW = Date.parse('2026-10-03T12:00:00Z');

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: PEER,
    body: 'Hello @[0190a000-0000-7000-8000-000000000002]',
    createdAt: new Date(NOW - 60 * 60_000).toISOString(),
    time: NOW - 60 * 60_000,
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
  } as ThreadMessage;
}

const DM: ChannelSummary = {
  channelId: `dm__${WS}__${ME}__${PEER}`,
  channelType: 'dm',
  title: 'Priya Raman',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: PEER,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('notes id and summary', () => {
  it('builds the id from the session user and the current workspace', () => {
    expect(notesChannelId(WS, ME)).toBe(`notes__${WS}__${ME}`);
    expect(notesChannelId(WS2, ME)).not.toBe(notesChannelId(WS, ME));
    const summary = notesSummary(WS, ME);
    expect(summary.channelId).toBe(notesChannelId(WS, ME));
    expect(summary.channelType).toBe('notes');
    expect(summary.title).toBe(NOTES_TITLE);
    expect(isNotesChannelId(summary.channelId)).toBe(true);
    expect(isNotesChannelId(DM.channelId)).toBe(false);
  });

  it('puts notes first in the forward picker and deep-link roster', () => {
    const list = withNotesFirst([DM], notesSummary(WS, ME));
    expect(list.map((c) => c.channelType)).toEqual(['notes', 'dm']);
  });

  it('keeps a notes row the registry read returned out of the list rows', () => {
    const rows = shapeChannelSummaries(
      [
        {
          channel_id: notesChannelId(WS, ME),
          channel_type: 'notes',
          workspace_id: WS,
          entity_id: null,
          dm_user_a: null,
          dm_user_b: null,
          owner_user_id: ME,
          agora_group_id: null,
          last_synced_at: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ] as never,
      new Map(),
      new Map(),
      ME,
    );
    expect(rows).toEqual([]);
  });
});

describe('notes_channel_ensure', () => {
  it('is called once per workspace per session and shared', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true as const, data: 'id' }));
    const ensurer = createNotesEnsurer(run);
    await Promise.all([ensurer.ensure(WS, ME), ensurer.ensure(WS, ME)]);
    await ensurer.ensure(WS, ME);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ensurer.state(WS, ME)).toBe('ready');
    await ensurer.ensure(WS2, ME);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed call so the next ask tries again', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'x' } })
      .mockResolvedValueOnce({ ok: true, data: 'id' });
    const ensurer = createNotesEnsurer(run);
    expect((await ensurer.ensure(WS, ME)).ok).toBe(false);
    expect(ensurer.state(WS, ME)).toBe('failed');
    expect((await ensurer.ensure(WS, ME)).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes p_workspace_id and a uuid_v7 p_trace_id', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'notes__x', error: null }));
    const result = await ensureNotesChannel({ rpc } as unknown as Client, { workspaceId: WS });
    expect(result.ok).toBe(true);
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe('notes_channel_ensure');
    expect(args.p_workspace_id).toBe(WS);
    expect(String(args.p_trace_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('waits at most the open budget, then fails', async () => {
    vi.useFakeTimers();
    const wait = waitForNotes(new Promise(() => {}), 5_000);
    vi.advanceTimersByTime(5_000);
    expect((await wait).ok).toBe(false);
    vi.useRealTimers();
  });

  it('never blocks the tile: the tile paints while the list is still loading', () => {
    const tree = channelListContent({
      channels: [],
      status: 'loading',
      onRetry: () => {},
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      notes: notesSummary(WS, ME),
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-notes-tile');
    expect(html).toContain('Personal notes');
    expect(html).toContain('Only you can see this');
    expect(html).toContain('Loading conversations');
    expect(html.indexOf('data-notes-tile')).toBeLessThan(html.indexOf('Loading conversations'));
  });

  it('keeps the tile out of Select mode (inert)', () => {
    const html = renderToStaticMarkup(
      channelListContent({
        channels: [DM],
        status: 'ready',
        onRetry: () => {},
        selectedChannelId: null,
        onSelect: () => {},
        onNewChat: () => {},
        search: '',
        onSearchChange: () => {},
        notes: notesSummary(WS, ME),
        select: {
          active: true,
          selectedIds: new Set(),
          onStart: () => {},
          onCancel: () => {},
          onToggle: () => {},
          onDelete: () => {},
        },
      }),
    );
    expect(html).toMatch(/data-notes-tile=""[^>]*disabled/);
  });
});

describe('no Agora for notes', () => {
  it('hands no live client, no target and no fan-out to notes', async () => {
    const client = { open: vi.fn(), send: vi.fn(), addEventHandler: vi.fn() };
    const notes = notesSummary(WS, ME);
    expect(liveClientFor(notes, client)).toBeNull();
    expect(liveClientFor(DM, client)).toBe(client);
    expect(targetFromSummary(notes)).toBeNull();
    const get = vi.fn();
    expect(await resolveLiveTarget(notes, ME, { get })).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(client.open).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('catches up on window focus, and the listener goes on teardown', () => {
    const add = vi.fn();
    const remove = vi.fn();
    const run = vi.fn();
    const stop = windowFocusTrigger(run, { addEventListener: add, removeEventListener: remove });
    const [type, handler] = add.mock.calls[0] as [string, () => void];
    expect(type).toBe('focus');
    handler();
    expect(run).toHaveBeenCalledTimes(1);
    stop();
    expect(remove).toHaveBeenCalledWith('focus', handler);
  });

  it('notes name nobody', () => {
    expect(mentionTargets(`hi @[${PEER}]`, 'notes')).toEqual([]);
  });
});

describe('Save to notes', () => {
  const photo = {
    assetId: '0190d000-0000-7000-8000-000000000001',
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    local: { key: 'k', file: null, previewUrl: 'blob:x' },
  };

  it('copies body, attachment ids and meta, cards, forwarded_from; no reply, no mentions', async () => {
    const source = message({
      attachments: [photo as never],
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      reply: { id: 'q', authorUserId: null, preview: 'x' },
    });
    const entry = saveToNotesEntry(source, 'new-id');
    expect(entry.local.forwardedFromMessageId).toBe('m1');
    expect(entry.local.reply).toBeNull();
    expect(entry.local.attachments[0]).not.toHaveProperty('local');
    const recordMessage = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: 'error' as const, message: 'stop' }),
    );
    await runSend(
      { recordMessage, publishLive: undefined, onLiveWarning: () => {} },
      {
        id: entry.id,
        channelId: notesChannelId(WS, ME),
        currentUserId: ME,
        traceId: 't',
        text: entry.text,
        local: entry.local,
      },
    );
    const sent = (recordMessage.mock.calls as unknown as [Record<string, unknown>][])[0]?.[0];
    expect(sent).toMatchObject({
      body: source.body,
      mentions: [],
      attachmentAssetIds: [photo.assetId],
      attachmentMeta: { [photo.assetId]: { mime: 'image/png', name: 'a.png', size: 10 } },
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      replyToMessageId: null,
      forwardedFromMessageId: 'm1',
    });
  });

  it('is offered only for recorded, live messages', () => {
    expect(canSaveToNotes(message())).toBe(true);
    expect(canSaveToNotes(message({ deleted: true }))).toBe(false);
    expect(canSaveToNotes(message({ state: 'sending' }))).toBe(false);
    expect(canSaveToNotes(message({ state: 'failed' }))).toBe(false);
  });
});

function labels(props: Partial<Parameters<typeof messageMenuItems>[0]>): string[] {
  return messageMenuItems({
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    onForward: () => {},
    canSelectText: true,
    onSelectText: () => {},
    canRemind: true,
    onRemind: () => {},
    ...props,
  }).map((item) => item.label);
}

describe('menu matrix', () => {
  it('DM and group: Save to notes sits between Copy and Remind me', () => {
    const rows = labels({
      canSaveToNotes: true,
      onSaveToNotes: () => {},
      markOptions: ['commitment'],
      onMark: () => {},
    });
    const copy = rows.indexOf('Copy');
    const save = rows.indexOf('Save to notes');
    expect(save).toBeGreaterThan(copy);
    expect(rows.indexOf('Remind me')).toBeGreaterThan(save);
    expect(rows).toContain('Mark as');
  });

  it('notes: no Mark as, no Save to notes, Delete for an hour-old own note with no hint', () => {
    const own = message({ mine: true, senderUserId: ME, body: 'note' });
    const actions = ownMessageActions(own, undefined, NOW, true);
    expect(actions.canDelete).toBe(true);
    expect(actions.canEdit).toBe(false);
    const items = messageMenuItems({
      canCopy: true,
      onReply: () => {},
      onCopy: () => {},
      canDelete: actions.canDelete,
      onDelete: () => {},
      notes: true,
    });
    const rows = items.map((i) => i.label);
    expect(rows).not.toContain('Mark as');
    expect(rows).not.toContain('Save to notes');
    const del = items.find((i) => i.kind === 'action' && i.key === 'delete');
    expect(del).toBeDefined();
    expect(del?.kind === 'action' ? del.hint : 'x').toBeUndefined();
  });

  it('a DM keeps its 30 minute delete window', () => {
    const own = message({ mine: true, senderUserId: ME, body: 'x' });
    expect(ownMessageActions(own, undefined, NOW).canDelete).toBe(false);
    const ids = new Set([own.id]);
    expect(deleteSelectionBlock(ids, [own], new Map(), NOW)).toBe('old');
    expect(deleteSelectionBlock(ids, [own], new Map(), NOW, true)).toBeNull();
  });

  it('notes tray has no Schedule tile (7 tiles); other chats keep it', () => {
    expect(trayTiles('touch', { schedule: false }).map((t) => t.id)).toEqual([
      'photos',
      'file',
      'assets',
      'brief',
      'post',
      'draft',
      'plan',
    ]);
    // Notes never shares a plan: the tile stays faded there and says why.
    expect(trayTiles('touch', { schedule: false }).find((t) => t.id === 'plan')?.ariaLabel).toBe(
      'Plan, not available in Personal notes',
    );
    expect(trayTiles('touch', { schedule: false }).find((t) => t.id === 'plan')?.disabled).toBe(
      true,
    );
    expect(trayTiles('touch').map((t) => t.id)).toContain('schedule');
  });

  it('notes: Draft is live for an agency-side viewer (no other members, so no client)', () => {
    const hasClient = channelHasClient([]);
    expect(hasClient).toBe(false);
    const tiles = trayTiles('touch', {
      schedule: false,
      draft: draftTileEnabled('agency', hasClient),
    });
    expect(tiles.find((t) => t.id === 'draft')?.disabled).toBeUndefined();
    const asClient = trayTiles('touch', {
      schedule: false,
      draft: draftTileEnabled('client', hasClient),
    });
    expect(asClient.find((t) => t.id === 'draft')?.disabled).toBe(true);
  });
});

describe('Saved from', () => {
  function fakeClient(rows: Record<string, unknown>[], users: Record<string, unknown>[]) {
    const calls: { table: string; ids: unknown }[] = [];
    const client = {
      from: (table: string) => ({
        select: () => ({
          in: (_col: string, ids: unknown) => {
            calls.push({ table, ids });
            return Promise.resolve({ data: table === 'users' ? users : rows, error: null });
          },
        }),
      }),
    } as unknown as Client;
    return { client, calls };
  }

  it('resolves a page of sources in one batched read, then one name read', async () => {
    const page = [
      message({ id: 'n1', forwarded: true, forwardedFromId: 's1' }),
      message({ id: 'n2', forwarded: true, forwardedFromId: 's2' }),
      message({ id: 'n3', forwarded: true, forwardedFromId: 's1' }),
    ];
    const ids = savedSourceIds(page, new Set());
    expect(ids).toEqual(['s1', 's2']);
    const { client, calls } = fakeClient(
      [{ id: 's1', channel_id: DM.channelId, sender_user_id: PEER, deleted_at: null }],
      [{ id: PEER, display_name: 'Priya Raman', avatar_url: null }],
    );
    const result = await readSavedSources(client, { ids, knownName: () => false });
    expect(calls.filter((c) => c.table === 'chat_messages')).toHaveLength(1);
    expect(calls.filter((c) => c.table === 'users')).toHaveLength(1);
    expect(result.ok && result.data.sources.map((s) => s.id)).toEqual(['s1']);
  });

  it('labels the line, a tombstone still jumps, an unreadable source does not', () => {
    const channels = new Map([[DM.channelId, DM]]);
    const nameOf = (): string => 'Priya Raman';
    const line = savedFromLine({
      source: { id: 's1', channelId: DM.channelId, senderUserId: PEER, deleted: true },
      channelsById: channels,
      nameOf,
      currentUserId: ME,
    });
    expect(line).toEqual({
      kind: 'source',
      label: 'Saved from Priya Raman · Priya',
      channelId: DM.channelId,
      messageId: 's1',
    });
    const gone = savedFromLine({ source: null, channelsById: channels, nameOf, currentUserId: ME });
    expect(gone).toEqual({ kind: 'unreadable', label: SAVED_MESSAGE_LABEL });
  });
});

describe('search chips', () => {
  it('sends p_kind with an empty query, and narrows with text', () => {
    expect(searchArgs({ workspaceId: WS, query: '', traceId: 't', kind: 'photo' })).toMatchObject({
      p_kind: 'photo',
      p_query: '',
    });
    expect(
      searchArgs({ workspaceId: WS, query: 'shoot', traceId: 't', kind: 'link' }),
    ).toMatchObject({ p_kind: 'link', p_query: 'shoot' });
    expect(searchArgs({ workspaceId: WS, query: 'shoot', traceId: 't' })).not.toHaveProperty(
      'p_kind',
    );
  });

  it('one chip at a time; tapping it again clears', () => {
    expect(toggleSearchKind(null, 'photo')).toBe('photo');
    expect(toggleSearchKind('photo', 'file')).toBe('file');
    expect(toggleSearchKind('file', 'file')).toBeNull();
    expect(showSearchResults('', 'voice')).toBe(true);
    expect(showSearchResults('', null)).toBe(false);
  });

  it('the runner fetches a chip alone and a chip with text', async () => {
    const timers: (() => void)[] = [];
    const fetch = vi.fn<SearchPageFetch>(() =>
      Promise.resolve({ ok: true, data: { hits: [], next: null } }),
    );
    const runner = createSearchRunner({
      fetch,
      onChange: () => {},
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    runner.setQuery('', 'photo');
    timers.splice(0).forEach((t) => t());
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({ query: '', kind: 'photo' });
    runner.setQuery('cover', 'photo');
    timers.splice(0).forEach((t) => t());
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({ query: 'cover', kind: 'photo' });
    runner.setQuery('', null);
    expect(timers).toHaveLength(0);
    runner.dispose();
  });
});

describe('notes thread chrome', () => {
  it('header: notebook square, title, no second line, not tappable', () => {
    const html = renderToStaticMarkup(
      <ThreadHeaderIdentity
        isGroup={false}
        notes
        title={NOTES_TITLE}
        avatarUrl={null}
        presence={undefined}
        headerLine={null}
        layout="touch"
      />,
    );
    expect(html).toContain('data-notes-avatar');
    expect(html).toContain(NOTES_TITLE);
    expect(html).not.toContain('data-header-line');
    expect(html).not.toContain('<button');
  });

  it('no open-loops strip without marks (notes pass none)', () => {
    expect(threadStripSlot({ hasMarks: false, selecting: false })).toBeNull();
    expect(threadStripSlot({ hasMarks: true, selecting: false })).toBe('loops');
  });
});

describe('forward picker order', () => {
  it('keeps Personal notes first whatever the recency', () => {
    const notes = notesSummary(WS, ME);
    const list = forwardPickerChannels([DM, notes], () => ({ lastMessageTs: 5 }), '');
    expect(list[0]?.channelType).toBe('notes');
    expect(forwardPickerChannels([DM, notes], () => undefined, 'priya')).toEqual([DM]);
  });
});
