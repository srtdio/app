import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import {
  canChangePriority,
  findInOlderPages,
  indexMarks,
  loadChannelMarks,
  NOTHING_OPEN,
  markBadgeLabel,
  openPostsHeading,
  openPostsPart,
  markCounts,
  markMenuLabel,
  markMenuOptions,
  markRowText,
  marksForTab,
  markStripLabel,
  markTabCounts,
  markConfirmAction,
  markConfirmCopy,
  applyTransition,
  resolverName,
  STAMP_WORD,
  MARKS_EVENT_HANDLER_ID,
  pruneSelection,
  rowToMark,
  selectionRole,
  subscribeMarkEvents,
  toggleSelected,
  deleteConfirmTitle,
  type ChatMark,
} from '@/lib/chat/marks';
import { markEventExt, type ChatMessageRow, type ThreadMessage } from '@/lib/chat/thread';

function mark(over: Partial<ChatMark>): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'c1',
    type: 'commitment',
    priority: null,
    markedAt: '2026-09-27T10:00:00+00:00',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  };
}

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'hello',
    createdAt: '2026-09-27T10:00:00+00:00',
    time: 1,
    provisionalTime: false,
    mine: true,
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

function row(id: string, created: string): ChatMessageRow {
  return {
    id,
    channel_id: 'c1',
    workspace_id: 'w',
    sender_user_id: 'u',
    body: 'b',
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
    created_at: created,
    edited_at: null,
    deleted_at: null,
  };
}

describe('marks menu', () => {
  it('offers all three types on an unmarked recorded message, in order', () => {
    expect(markMenuOptions(message({}), undefined)).toEqual(['commitment', 'decision', 'pending']);
    expect(markMenuOptions(message({}), undefined).map(markMenuLabel)).toEqual([
      'Mark as Commitment',
      'Mark as Decision',
      'Mark as Pending',
    ]);
  });

  it('frozen marks expose no actions: commitment, decision, resolved pending', () => {
    for (const m of [
      mark({ type: 'commitment' }),
      mark({ type: 'decision' }),
      mark({ type: 'pending', resolved: true }),
    ]) {
      expect(markMenuOptions(message({}), m)).toEqual([]);
      expect(canChangePriority(m)).toBe(false);
    }
  });

  it('an open pending mark shows no menu options but its badge changes priority', () => {
    const pending = mark({ type: 'pending', priority: 1 });
    expect(markMenuOptions(message({}), pending)).toEqual([]);
    expect(canChangePriority(pending)).toBe(true);
  });

  it('an unrecorded message cannot be marked', () => {
    expect(markMenuOptions(message({ state: 'sending' }), undefined)).toEqual([]);
    expect(markMenuOptions(message({ state: 'failed' }), undefined)).toEqual([]);
    expect(markMenuOptions(message({ deleted: true }), undefined)).toEqual([]);
  });
});

describe('badges', () => {
  it('labels each type, adds P1/P2 on pending, and appends the stamp word once resolved', () => {
    expect(markBadgeLabel(undefined)).toBe('');
    expect(markBadgeLabel(mark({ type: 'commitment' }))).toBe('Commitment');
    expect(markBadgeLabel(mark({ type: 'decision' }))).toBe('Decision');
    expect(markBadgeLabel(mark({ type: 'pending' }))).toBe('Pending');
    expect(markBadgeLabel(mark({ type: 'pending', priority: 2 }))).toBe('Pending P2');
    expect(markBadgeLabel(mark({ type: 'pending', priority: 1, resolved: true }))).toBe(
      'Pending · Completed',
    );
    expect(markBadgeLabel(mark({ type: 'commitment', resolved: true }))).toBe(
      'Commitment · Delivered',
    );
    expect(markBadgeLabel(mark({ type: 'decision', resolved: true }))).toBe('Decision · Closed');
  });
});

describe('strip counts', () => {
  it('counts open marks and P1s, hiding zero counts', () => {
    const marks = [
      mark({ messageId: 'a', type: 'commitment' }),
      mark({ messageId: 'b', type: 'commitment' }),
      mark({ messageId: 'c', type: 'pending', priority: 1 }),
      mark({ messageId: 'd', type: 'pending' }),
      mark({ messageId: 'e', type: 'pending', priority: 1, resolved: true }),
    ];
    const counts = markCounts(marks);
    expect(counts).toEqual({ commitments: 2, decisions: 0, pending: 2, p1: 1 });
    expect(markStripLabel(counts)).toBe('2 commitments · 2 pending (1 P1)');
    expect(markStripLabel(markCounts([mark({ type: 'decision' })]))).toBe('1 decision');
    expect(markStripLabel(markCounts([mark({ type: 'pending' })]))).toBe('1 pending');
    expect(markStripLabel(markCounts([]))).toBe('');
  });
});

describe('open posts wording', () => {
  it('posts part per side, never a guess', () => {
    expect(openPostsPart(1, 'client')).toBe('1 post waiting on you');
    expect(openPostsPart(2, 'agency')).toBe('2 posts waiting on client');
    expect(openPostsPart(1, 'unknown')).toBe('1 post in review');
    expect(NOTHING_OPEN).toBe('Nothing open between you');
  });

  it('sheet headings follow the side', () => {
    expect(openPostsHeading('client')).toBe('Posts waiting on you');
    expect(openPostsHeading('agency')).toBe('Posts waiting on client');
    expect(openPostsHeading('unknown')).toBe('Posts in review');
  });
});

describe('sheet lists', () => {
  const time = (m: ChatMark): number => Date.parse(m.markedAt);

  it('Open lists every unresolved mark, newest first', () => {
    const list = marksForTab(
      [
        mark({ messageId: 'old', markedAt: '2026-09-01T00:00:00Z' }),
        mark({ messageId: 'new', type: 'pending', markedAt: '2026-09-20T00:00:00Z' }),
        mark({ messageId: 'dec', type: 'decision', markedAt: '2026-09-10T00:00:00Z' }),
        mark({ messageId: 'done', resolved: true, resolvedAt: '2026-09-21T00:00:00Z' }),
      ],
      'open',
      time,
    );
    expect(list.map((m) => m.messageId)).toEqual(['new', 'dec', 'old']);
  });

  it('History lists stamped marks, most recently stamped first', () => {
    const list = marksForTab(
      [
        mark({ messageId: 'open' }),
        mark({ messageId: 'a', resolved: true, resolvedAt: '2026-09-02T00:00:00Z' }),
        mark({
          messageId: 'b',
          type: 'decision',
          resolved: true,
          resolvedAt: '2026-09-05T00:00:00Z',
        }),
        mark({
          messageId: 'c',
          type: 'pending',
          resolved: true,
          resolvedAt: '2026-09-03T00:00:00Z',
        }),
      ],
      'history',
      time,
    );
    expect(list.map((m) => m.messageId)).toEqual(['b', 'c', 'a']);
  });

  it('a stamp moves the row from Open to History and a reopen moves it back', () => {
    const open = mark({ messageId: 'a', type: 'pending' });
    const before = indexMarks([open, mark({ messageId: 'b', type: 'decision' })]);
    expect(markTabCounts(before.values())).toEqual({ open: 2, history: 0 });
    const stamped = applyTransition(open, 'resolve', 'u1', '2026-09-28T09:00:00Z');
    const after = new Map(before).set('a', stamped);
    expect(marksForTab(after.values(), 'open', time).map((m) => m.messageId)).toEqual(['b']);
    expect(marksForTab(after.values(), 'history', time)).toEqual([stamped]);
    expect(markCounts(after.values()).pending).toBe(0);
    const reopened = applyTransition(stamped, 'reopen', 'u2', '2026-09-28T10:00:00Z');
    expect(reopened).toEqual(open);
    expect(reopened.markedAt).toBe(open.markedAt);
  });

  it('stamp words and confirm copy per type', () => {
    expect(STAMP_WORD).toEqual({
      commitment: 'Delivered',
      decision: 'Closed',
      pending: 'Completed',
    });
    expect(markConfirmCopy('commitment', 'resolve')).toBe('Mark this commitment as delivered?');
    expect(markConfirmCopy('decision', 'resolve')).toBe('Mark this decision as closed?');
    expect(markConfirmCopy('pending', 'resolve')).toBe('Mark this priority as completed?');
    expect(markConfirmCopy('commitment', 'reopen')).toBe('Reopen this commitment?');
    expect(markConfirmCopy('decision', 'reopen')).toBe('Reopen this decision?');
    expect(markConfirmCopy('pending', 'reopen')).toBe('Reopen this priority?');
    expect(markConfirmAction('decision', 'resolve')).toBe('Closed');
    expect(markConfirmAction('decision', 'reopen')).toBe('Reopen');
  });

  it('resolver name: You, a loaded profile, else Member', () => {
    const names = (id: string): string | undefined => (id === 'u2' ? 'Asha' : undefined);
    expect(resolverName({ resolvedBy: 'u1' }, 'u1', names)).toBe('You');
    expect(resolverName({ resolvedBy: 'u2' }, 'u1', names)).toBe('Asha');
    expect(resolverName({ resolvedBy: 'u3' }, 'u1', names)).toBe('Member');
    expect(resolverName({ resolvedBy: null }, 'u1', names)).toBe('Member');
  });

  it('row text is the first 80 chars, else the card title', () => {
    expect(markRowText(message({ body: 'x'.repeat(100) }), undefined)).toBe(`${'x'.repeat(80)}…`);
    expect(markRowText(message({ body: '', sharedBriefIds: ['b'] }), 'Autumn launch')).toBe(
      'Autumn launch',
    );
    expect(markRowText(message({ body: '', sharedBriefIds: ['b'] }), undefined)).toBe(
      'Shared brief',
    );
    expect(markRowText(undefined, undefined)).toBe('Message');
  });
});

describe('selection mode', () => {
  const marks = indexMarks([
    mark({ messageId: 'marked' }),
    mark({ messageId: 'resolved', type: 'pending', resolved: true }),
  ]);

  it("excludes others' messages and locks own marked ones (resolved included)", () => {
    expect(selectionRole(message({ id: 'own' }), marks)).toBe('selectable');
    expect(selectionRole(message({ id: 'theirs', mine: false }), marks)).toBe('none');
    expect(selectionRole(message({ id: 'marked' }), marks)).toBe('locked');
    expect(selectionRole(message({ id: 'resolved' }), marks)).toBe('locked');
    expect(selectionRole(message({ id: 'sending', state: 'sending' }), marks)).toBe('none');
  });

  it('a deleted own message is never selectable', () => {
    expect(selectionRole(message({ id: 'own', deleted: true }), marks)).toBe('none');
  });

  it('toggles and prunes ids that stopped being selectable', () => {
    const selected = toggleSelected(toggleSelected(new Set(), 'own'), 'marked');
    expect([...selected]).toEqual(['own', 'marked']);
    expect([...toggleSelected(selected, 'own')]).toEqual(['marked']);
    const pruned = pruneSelection(
      selected,
      [message({ id: 'own' }), message({ id: 'marked' })],
      marks,
    );
    expect([...pruned]).toEqual(['own']);
    expect(deleteConfirmTitle(1)).toBe('Delete 1 message for everyone?');
    expect(deleteConfirmTitle(3)).toBe('Delete 3 messages for everyone?');
  });
});

describe('findInOlderPages (jump-to)', () => {
  function pager(pages: number, targetOn: number | null) {
    let page = 0;
    return vi.fn(() => {
      page += 1;
      const ids = [`p${page}-a`, `p${page}-b`];
      if (page === targetOn) ids.push('target');
      return Promise.resolve({
        ok: true as const,
        data: {
          rows: ids.map((id, i) =>
            row(id, `2026-09-${String(30 - page).padStart(2, '0')}T0${i}:00:00Z`),
          ),
          hasMore: page < pages,
        },
      });
    });
  }
  const start = { createdAt: '2026-09-30T00:00:00Z', id: 'newest' };

  it('loads older pages until the target is found, folding each page', async () => {
    const loadPage = pager(20, 3);
    const onPage = vi.fn();
    const outcome = await findInOlderPages({ start, targetId: 'target', loadPage, onPage });
    expect(outcome).toBe('found');
    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(onPage).toHaveBeenCalledTimes(3);
    // Each next page continues from the oldest row of the previous one.
    expect((loadPage.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual({
      createdAt: '2026-09-29T00:00:00Z',
      id: 'p1-a',
    });
  });

  it('gives up after 10 pages', async () => {
    const loadPage = pager(50, null);
    const outcome = await findInOlderPages({
      start,
      targetId: 'target',
      loadPage,
      onPage: vi.fn(),
    });
    expect(outcome).toBe('exhausted');
    expect(loadPage).toHaveBeenCalledTimes(10);
  });

  it('stops when history runs out, and reports a failed page', async () => {
    const loadPage = pager(2, null);
    expect(await findInOlderPages({ start, targetId: 'target', loadPage, onPage: vi.fn() })).toBe(
      'not_found',
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(
      await findInOlderPages({
        start,
        targetId: 'target',
        loadPage: () => Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } }),
        onPage: vi.fn(),
      }),
    ).toBe('error');
    expect(
      await findInOlderPages({ start: undefined, targetId: 't', loadPage, onPage: vi.fn() }),
    ).toBe('not_found');
  });
});

describe('mark reads and live signal', () => {
  it('maps rows, keeping priority for pending only', () => {
    const base = {
      message_id: 'm',
      channel_id: 'c',
      workspace_id: 'w',
      marked_at: 't',
      marked_by: null,
      resolved_by: null,
    };
    expect(rowToMark({ ...base, mark_type: 'pending', priority: 1, resolved_at: null })).toEqual({
      messageId: 'm',
      channelId: 'c',
      type: 'pending',
      priority: 1,
      markedAt: 't',
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    });
    expect(
      rowToMark({ ...base, mark_type: 'decision', priority: 2, resolved_at: null })?.priority,
    ).toBeNull();
    expect(
      rowToMark({ ...base, mark_type: 'bogus', priority: null, resolved_at: null }),
    ).toBeUndefined();
  });

  it('loads every mark of a channel in one query', async () => {
    const eq = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            message_id: 'm',
            channel_id: 'c',
            workspace_id: 'w',
            mark_type: 'pending',
            priority: null,
            marked_by: null,
            marked_at: 't',
            resolved_by: 'u',
            resolved_at: 't2',
          },
        ],
        error: null,
      }),
    );
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const result = await loadChannelMarks({ from } as unknown as Client, 'c');
    expect(from).toHaveBeenCalledWith('chat_message_marks');
    expect(eq).toHaveBeenCalledWith('channel_id', 'c');
    expect(result.ok && result.data[0]?.resolved).toBe(true);
  });

  it('routes a mark cmd to onMark under its own handler id', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = {
      addEventHandler: vi.fn((id: string, h: AgoraChat.EventHandlerType) => {
        handlers[id] = h;
      }),
      removeEventHandler: vi.fn(),
    };
    const onMark = vi.fn();
    const teardown = subscribeMarkEvents(connection, onMark);
    const handler = handlers[MARKS_EVENT_HANDLER_ID];
    handler?.onCmdMessage?.({
      ext: markEventExt({ messageId: 'm7' }),
    } as unknown as AgoraChat.CmdMsgBody);
    handler?.onCmdMessage?.({
      ext: { sorted_event: 'read', message_id: 'x', channel_id: 'c' },
    } as unknown as AgoraChat.CmdMsgBody);
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenCalledWith('m7');
    teardown();
    expect(connection.removeEventHandler).toHaveBeenCalledWith(MARKS_EVENT_HANDLER_ID);
  });
});

describe('plan card rows', () => {
  it('a bodyless plan message reads its card title, else "Shared plan"', () => {
    const plan = {
      body: '',
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      sharedPlanIds: ['plan1'],
    };
    expect(markRowText(plan, 'Week of 12 Oct')).toBe('Week of 12 Oct');
    expect(markRowText(plan, undefined)).toBe('Shared plan');
  });
});
