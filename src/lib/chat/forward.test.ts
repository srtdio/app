import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  canDeleteSelection,
  canForward,
  DELETE_BLOCK_COPY,
  deleteSelectionBlock,
  forwardFailedMessage,
  forwardPickerChannels,
  forwardPreviewText,
  forwardRecordInput,
  forwardableInOrder,
  pruneThreadSelection,
  runForward,
  scheduleSelectionBoundary,
  selectedForForward,
  threadSelectable,
  threadSelectionRole,
  sendToLabel,
  toggleForwardTarget,
} from '@/lib/chat/forward';

function msg(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer',
    body: 'hello',
    createdAt: '2026-09-22T10:00:00Z',
    time: 1,
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

function channel(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c1',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const mark = (id: string): ChatMark =>
  ({ messageId: id, type: 'decision', priority: null }) as unknown as ChatMark;

describe('forwardable messages', () => {
  it('only recorded messages can be forwarded', () => {
    expect(canForward(msg({ state: 'sent' }))).toBe(true);
    expect(canForward(msg({ state: 'sending' }))).toBe(false);
    expect(canForward(msg({ state: 'failed' }))).toBe(false);
    expect(canForward(msg({ state: 'sent', deleted: true }))).toBe(false);
  });

  it('keeps thread order and drops unrecorded bubbles', () => {
    const list = forwardableInOrder([
      msg({ id: 'b', time: 2 }),
      msg({ id: 'x', time: 3, state: 'failed' }),
      msg({ id: 'a', time: 1 }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('selectedForForward returns the selected ones in thread order', () => {
    const messages = [
      msg({ id: 'a', time: 1 }),
      msg({ id: 'b', time: 2 }),
      msg({ id: 'c', time: 3 }),
    ];
    expect(selectedForForward(new Set(['c', 'a']), messages).map((m) => m.id)).toEqual(['a', 'c']);
  });
});

describe('thread selection (Forward any, Delete own only)', () => {
  const messages = [
    msg({ id: 'own', mine: true }),
    msg({ id: 'peer', mine: false }),
    msg({ id: 'marked', mine: true }),
    msg({ id: 'pending', mine: true, state: 'sending' }),
  ];
  const marks = new Map([['marked', mark('marked')]]);

  it('prunes to loaded, recorded messages of any sender', () => {
    const pruned = pruneThreadSelection(new Set(['own', 'peer', 'pending', 'gone']), messages);
    expect([...pruned].sort()).toEqual(['own', 'peer']);
  });

  it('F8 rows: any recorded message is selectable, marked ones included; deleted and pending nothing', () => {
    expect(threadSelectionRole(msg({ id: 'own', mine: true }))).toBe('selectable');
    expect(threadSelectionRole(msg({ id: 'peer', mine: false }))).toBe('selectable');
    expect(threadSelectionRole(msg({ id: 'marked', mine: true }))).toBe('selectable');
    expect(threadSelectionRole(msg({ id: 'pending', mine: true, state: 'sending' }))).toBe('none');
    expect(threadSelectionRole(msg({ id: 'd', mine: true, deleted: true }))).toBe('none');
    expect(threadSelectable(msg({ id: 'marked', mine: true }))).toBe(true);
  });

  it('prunes deleted messages from the selection and keeps marked ones', () => {
    const list = [...messages, msg({ id: 'd', mine: true, deleted: true })];
    const pruned = pruneThreadSelection(new Set(['own', 'peer', 'marked', 'd']), list);
    expect([...pruned].sort()).toEqual(['marked', 'own', 'peer']);
  });

  // Server time 5 minutes after the fixtures' created_at (inside the window).
  const NOW = Date.parse('2026-09-22T10:05:00Z');

  it('allows delete only when every selected message is own and unmarked', () => {
    expect(canDeleteSelection(new Set(), messages, marks, NOW)).toBe(false);
    expect(canDeleteSelection(new Set(['own']), messages, marks, NOW)).toBe(true);
    expect(canDeleteSelection(new Set(['own', 'peer']), messages, marks, NOW)).toBe(false);
    expect(canDeleteSelection(new Set(['marked']), messages, marks, NOW)).toBe(false);
  });

  it('D4: Delete is disabled for an own message older than 30 min, on server time', () => {
    const late = Date.parse('2026-09-22T10:31:00Z');
    expect(canDeleteSelection(new Set(['own']), messages, marks, late)).toBe(false);
    expect(deleteSelectionBlock(new Set(['own']), messages, marks, late)).toBe('old');
    // Exactly 30 minutes is still inside (the proc's >= now() - 30 min).
    const edge = Date.parse('2026-09-22T10:30:00Z');
    expect(canDeleteSelection(new Set(['own']), messages, marks, edge)).toBe(true);
  });

  it('D4: both reason lines; others wins over age; none at 0 or when allowed', () => {
    const late = Date.parse('2026-09-22T10:31:00Z');
    expect(deleteSelectionBlock(new Set(['own', 'peer']), messages, marks, NOW)).toBe('others');
    expect(deleteSelectionBlock(new Set(['own', 'peer']), messages, marks, late)).toBe('others');
    expect(deleteSelectionBlock(new Set(), messages, marks, late)).toBeNull();
    expect(deleteSelectionBlock(new Set(['own']), messages, marks, NOW)).toBeNull();
    expect(DELETE_BLOCK_COPY.others).toBe('Only your own messages can be deleted');
    expect(DELETE_BLOCK_COPY.old).toBe("Messages older than 30 min can't be deleted");
  });

  it('F8: a marked own message disables Delete with its reason; priority others > marked > old', () => {
    const late = Date.parse('2026-09-22T10:31:00Z');
    expect(deleteSelectionBlock(new Set(['marked']), messages, marks, NOW)).toBe('marked');
    expect(DELETE_BLOCK_COPY.marked).toBe("Marked messages can't be deleted");
    expect(deleteSelectionBlock(new Set(['marked', 'own']), messages, marks, late)).toBe('marked');
    expect(deleteSelectionBlock(new Set(['marked', 'peer']), messages, marks, NOW)).toBe('others');
    expect(deleteSelectionBlock(new Set(['own']), messages, marks, late)).toBe('old');
  });

  it('R7: priority is others > marked > old; there is no sending reason (those rows are never selectable)', () => {
    const late = Date.parse('2026-09-22T10:31:00Z');
    expect(Object.keys(DELETE_BLOCK_COPY).sort()).toEqual(['marked', 'old', 'others']);
    expect(deleteSelectionBlock(new Set(['marked', 'own', 'peer']), messages, marks, late)).toBe(
      'others',
    );
    expect(deleteSelectionBlock(new Set(['marked', 'own']), messages, marks, late)).toBe('marked');
    expect(deleteSelectionBlock(new Set(['own']), messages, marks, late)).toBe('old');
    expect(threadSelectable(msg({ id: 'failed', mine: true, state: 'failed' }))).toBe(false);
    expect(threadSelectable(msg({ id: 'pending', mine: true, state: 'sending' }))).toBe(false);
  });
});

describe('F2: the selection Delete window boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('one timeout flips Delete when the earliest selected own message crosses 30 min', () => {
    vi.useFakeTimers();
    // Server clock 2 minutes ahead of the device.
    const offset = 120_000;
    vi.setSystemTime(Date.parse('2026-09-22T10:20:00Z') - offset);
    const now = (): number => Date.now() + offset;
    const list = [
      msg({ id: 'early', mine: true, createdAt: '2026-09-22T10:00:00Z' }),
      msg({ id: 'later', mine: true, createdAt: '2026-09-22T10:10:00Z' }),
    ];
    const selected = new Set(['early', 'later']);
    const onBoundary = vi.fn();
    const noMarks = new Map<string, ChatMark>();
    expect(deleteSelectionBlock(selected, list, noMarks, now())).toBeNull();
    scheduleSelectionBoundary({ selected, messages: list, now, onBoundary });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(10 * 60_000);
    expect(onBoundary).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onBoundary).toHaveBeenCalledOnce();
    expect(deleteSelectionBlock(selected, list, noMarks, now())).toBe('old');
  });

  it('the cancel clears the timer (exit, unmount); nothing is scheduled past the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-22T10:05:00Z'));
    const list = [msg({ id: 'own', mine: true })];
    const cancel = scheduleSelectionBoundary({
      selected: new Set(['own']),
      messages: list,
      now: Date.now,
      onBoundary: vi.fn(),
    });
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(Date.parse('2026-09-22T11:00:00Z'));
    scheduleSelectionBoundary({
      selected: new Set(['own']),
      messages: list,
      now: Date.now,
      onBoundary: vi.fn(),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('forward picker', () => {
  const channels = [
    channel({ channelId: 'old', title: 'Old team' }),
    channel({ channelId: 'new', title: 'Acme client' }),
    channel({ channelId: 'hidden', title: 'Hidden DM', channelType: 'dm' }),
  ];
  const ts: Record<string, number> = { old: 10, new: 20, hidden: 5 };

  it('lists every chat (hidden included) most recent first, and filters by name', () => {
    const all = forwardPickerChannels(channels, (id) => ({ lastMessageTs: ts[id] ?? 0 }), '');
    expect(all.map((c) => c.channelId)).toEqual(['new', 'old', 'hidden']);
    const found = forwardPickerChannels(channels, (id) => ({ lastMessageTs: ts[id] ?? 0 }), 'acme');
    expect(found.map((c) => c.channelId)).toEqual(['new']);
  });

  it('toggles targets and labels the send button', () => {
    const one = toggleForwardTarget(new Set(), 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggleForwardTarget(one, 'a')]).toEqual([]);
    expect(sendToLabel(0)).toBe('Send to 0 chats');
    expect(sendToLabel(1)).toBe('Send to 1 chat');
    expect(sendToLabel(3)).toBe('Send to 3 chats');
    expect(forwardFailedMessage('Design')).toBe('Could not forward to Design.');
  });
});

describe('forwardRecordInput', () => {
  it('copies body, attachments with meta, posts and briefs; no reply; the source id', () => {
    const source = msg({
      id: 'src',
      body: 'see this',
      attachments: [{ assetId: 'v1', name: 'a.png', mime: 'image/png', size: 5 }],
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      reply: { id: 'q', authorUserId: null, preview: 'x' },
    });
    expect(forwardRecordInput(source, { id: 'new', channelId: 'c2', traceId: 't' })).toEqual({
      id: 'new',
      channelId: 'c2',
      traceId: 't',
      body: 'see this',
      attachmentAssetIds: ['v1'],
      attachmentMeta: { v1: { mime: 'image/png', name: 'a.png', size: 5 } },
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      replyToMessageId: null,
      forwardedFromMessageId: 'src',
    });
  });

  it('never carries mentions: a forwarded body keeps its tokens, p_mentions is not sent', () => {
    const X = '11111111-1111-4111-8111-111111111111';
    const input = forwardRecordInput(msg({ body: `hi @[${X}]` }), {
      id: 'new',
      channelId: 'c2',
      traceId: 't',
    });
    expect(input.body).toBe(`hi @[${X}]`);
    expect(input).not.toHaveProperty('mentions');
  });

  it('previews an attachment-only forward as Attachment', () => {
    expect(forwardPreviewText(msg({ body: '', sharedPostIds: ['p'] }))).toBe('Attachment');
    expect(forwardPreviewText(msg({ body: 'hi' }))).toBe('hi');
  });
});

describe('runForward', () => {
  const targets = ['a', 'b', 'c'];
  const messages = [msg({ id: 'm1' }), msg({ id: 'm2' })];

  it('sends each message to each chat in order', async () => {
    const calls: string[] = [];
    const result = await runForward({
      targets,
      messages,
      sendOne: (t, m) => {
        calls.push(`${t}:${m.id}`);
        return Promise.resolve({ ok: true });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['a:m1', 'a:m2', 'b:m1', 'b:m2', 'c:m1', 'c:m2']);
  });

  it('stops on the first failure and names that chat', async () => {
    const sendOne = vi.fn((t: string, m: ThreadMessage) =>
      Promise.resolve(
        t === 'b' && m.id === 'm1' ? { ok: false as const, message: 'x' } : { ok: true as const },
      ),
    );
    const result = await runForward({ targets, messages, sendOne });
    expect(result).toEqual({ ok: false, failed: 'b', message: 'x' });
    expect(sendOne).toHaveBeenCalledTimes(3);
  });
});

describe('forwardRecordInput: thumbnail meta rides along', () => {
  it('a forwarded PDF keeps page_count and the stored thumbnail size', () => {
    const source = msg({
      id: 'src',
      attachments: [
        {
          assetId: 'v-pdf',
          name: 'deck.pdf',
          mime: 'application/pdf',
          size: 900,
          pageCount: 12,
          thumbW: 580,
          thumbH: 751,
        },
      ],
    });
    const input = forwardRecordInput(source, { id: 'new', channelId: 'c2', traceId: 't' });
    expect(input.attachmentMeta).toEqual({
      'v-pdf': {
        mime: 'application/pdf',
        name: 'deck.pdf',
        size: 900,
        page_count: 12,
        thumb_w: 580,
        thumb_h: 751,
      },
    });
  });
});
