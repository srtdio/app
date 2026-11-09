import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The thread module's import graph pulls the agora-chat browser SDK.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  bodyMetaOf,
  MENTION_ME_PEER,
  mentionClass,
  MessageBubble,
  metaIsEmpty,
  taskTitleOf,
  TASK_FROM_MESSAGE_MAX,
} from '@/components/chat/MessageThread';
import {
  ADD_TO_TASKS_LABEL,
  COPY_LINK_LABEL,
  itemsOfGroup,
  MARK_UNREAD_LABEL,
  MenuTile,
  messageMenuItems,
  QUICK_REACTIONS,
} from '@/components/chat/MessageActionMenu';
import { RepliesRow } from '@/components/chat/ThreadRail';
import { UnreadDivider } from '@/components/chat/ReadingLayer';
import { threadsRows, THREADS_EMPTY } from '@/components/chat/ThreadsSheet';
import { THREAD_TITLE } from '@/lib/chat/thread-rail';
import { ThreadsStripItem } from '@/components/chat/StatusTicker';
import { avatarShapeClass } from '@/components/ui/Avatar';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import { breaksRun } from '@/lib/chat/thread';
import { chatMessageHref } from '@/lib/inbox/bell-types';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['me', { userId: 'me', displayName: 'Shubham Gune', avatarUrl: null }],
  ['leo', { userId: 'leo', displayName: 'Leo Park', avatarUrl: null }],
]);

const CREATED_AT = '2026-11-08T10:05:00.000000+00:00';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'leo',
    body: 'Morning all.',
    createdAt: CREATED_AT,
    time: Date.parse(CREATED_AT),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    threadRootId: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function bubbleHtml(
  message: ThreadMessage,
  opts: { head?: boolean; isGroup?: boolean } = {},
): string {
  return renderToStaticMarkup(
    MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: opts.isGroup ?? false,
      head: opts.head ?? true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      viewerUserId: 'me',
      onBadgeClick: () => {},
    }),
  );
}

describe('L1: everyone on the left, no bubbles', () => {
  it('a peer head: square photo 32, name and clock time on line 1, no fill', () => {
    const html = bubbleHtml(msg());
    expect(html).toContain('data-sender-name');
    expect(html).toContain('Leo Park');
    expect(html).toContain('data-sender-time');
    expect(html).toContain('data-avatar-role="header"');
    expect(html).not.toContain('bg-panel-2 text-fg lit-bubble-other');
    expect(html).not.toContain('flex-row-reverse');
  });

  it('own messages look the same: own photo, own name (never "You"), left side, ticks after the time', () => {
    const html = bubbleHtml(msg({ mine: true, senderUserId: 'me', status: 'read' }));
    expect(html).toContain('Shubham Gune');
    expect(html).toContain('data-avatar-role="header"');
    expect(html).not.toContain('bg-bubble-own');
    expect(html).not.toContain('flex-row-reverse');
    expect(html).not.toContain('items-end');
  });

  it('a continuation within 5 minutes: no photo or name, the body under the first', () => {
    const html = bubbleHtml(msg(), { head: false });
    expect(html).not.toContain('data-sender-name');
    expect(html).toContain('w-8 shrink-0');
    expect(
      breaksRun(
        { mine: false, senderUserId: 'leo', time: 0 + 1 },
        { mine: false, senderUserId: 'leo', time: 4 * 60_000 },
      ),
    ).toBe(false);
  });

  it('the deleted message is one grey italic line in the same layout', () => {
    const html = bubbleHtml(msg({ deleted: true, body: '' }));
    expect(html).toContain('data-deleted');
    expect(html).toContain('italic');
    expect(html).toContain('text-fg-3');
    expect(html).not.toContain('bg-panel-2');
  });

  it('the head carries the time, so the body meta keeps only edited and the continuation state', () => {
    const meta = { time: '10:05 AM', edited: false, status: 'sending' as const };
    expect(metaIsEmpty(bodyMetaOf(meta, true))).toBe(true);
    expect(bodyMetaOf(meta, false)).toEqual({ time: '', edited: false, status: 'sending' });
  });
});

describe('L2: square photos', () => {
  it('a person is a rounded square at every size', () => {
    expect(avatarShapeClass('header')).toBe('rounded-lg');
    expect(avatarShapeClass('stack')).toBe('rounded-lg');
    expect(avatarShapeClass('profile')).toBe('rounded-xl');
  });
});

describe('L3: the replies row', () => {
  it('photos, semibold ink count, the last reply time (no reply text) and the dot in one 44 target', () => {
    const html = renderToStaticMarkup(
      createElement(RepliesRow, {
        label: '2 replies',
        repliers: [{ id: 'leo', name: 'Leo Park' }],
        time: 'Today at 10:12 AM',
        unread: true,
        coarse: true,
        onOpen: () => {},
      }),
    );
    expect(html).toContain('data-replies-row');
    expect(html).toContain('data-avatar-role="stack"');
    expect(html).toContain('font-semibold');
    expect(html).toContain('data-replies-time');
    expect(html).toContain('Today at 10:12 AM');
    expect(html).not.toContain('data-replies-latest');
    expect(html).not.toContain('text-accent');
    expect(html).toContain(
      'aria-label="2 replies, last reply Today at 10:12 AM, unread. Open thread"',
    );
    expect(html).toContain('truncate');
    expect(html).toContain('data-replies-dot');
    expect(html).toContain('min-h-11');
  });

  it('read: no dot', () => {
    const html = renderToStaticMarkup(
      createElement(RepliesRow, {
        label: '1 reply',
        repliers: [],
        time: '',
        unread: false,
        coarse: false,
        onOpen: () => {},
      }),
    );
    expect(html).not.toContain('data-replies-dot');
  });
});

describe('L4: the thread screen', () => {
  it('composer hint "Reply", no Also send to chat, every thread titled by threadTitleOf over the chat name', () => {
    const src = read('../MessageThread.tsx') + read('../MessageBubble.tsx');
    expect(src).toContain("const THREAD_REPLY_PLACEHOLDER = 'Reply';");
    expect(src).not.toContain('Also send to chat');
    expect(src).toContain('const viewTitle = threadTitleOf(viewRoot, cardTitles);');
    // The chat's name is the second line of every thread (card threads too).
    expect(src).toContain('const viewSubtitle = props.title;');
    expect(src).not.toContain("viewPost?.title ?? 'Thread'");
    expect(read('../ThreadView.tsx')).toContain('data-thread-view-subtitle');
  });

  it('the thread title reads only held caches: no await or read on the open path', () => {
    const src = read('../MessageThread.tsx');
    const start = src.indexOf('export function heldCardTitles(');
    const block = src.slice(start, src.indexOf('function ThreadViewTitled(', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toMatch(/await|\.request\(|fetch|callRpc|\.from\(/);
  });
});

describe('L6: the Threads sheet rows', () => {
  it('unread first, then read; root sender, the root first line and "N replies"', () => {
    const root = msg({ id: 'root', body: 'Can we tighten the hook?' });
    const rows = threadsRows({
      threads: [
        {
          rootId: 'old',
          replyCount: 1,
          lastReplyAt: '2026-11-08T11:00:00Z',
          lastReplyId: 'x',
          lastReplySender: 'leo',
          lastReplyBody: 'ok',
          unread: false,
        },
        {
          rootId: 'root',
          replyCount: 3,
          lastReplyAt: '2026-11-08T10:00:00Z',
          lastReplyId: 'y',
          lastReplySender: 'leo',
          lastReplyBody: 'Done',
          unread: true,
        },
      ],
      rootOf: (id) => (id === 'root' ? root : undefined),
      nameOf: (id) => PROFILES.get(id ?? '')?.displayName ?? 'Member',
      photoOf: () => undefined,
      now: new Date('2026-11-08T12:00:00Z'),
    });
    expect(rows.map((r) => r.rootId)).toEqual(['root', 'old']);
    expect(rows[0]).toMatchObject({
      name: 'Leo Park',
      preview: 'Can we tighten the hook?',
      tag: '3 replies',
      unread: true,
    });
    expect(THREADS_EMPTY).toBe('Threads show up here.');
  });

  it('the strip item: "N threads" with its dot', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadsStripItem, { label: '2 threads', onOpen: () => {} }),
    );
    expect(html).toContain('2 threads');
    expect(html).toContain('data-threads-dot');
  });
});

describe('L7: the New line', () => {
  it('a thick ink rule and an ink "New" pill', () => {
    const html = renderToStaticMarkup(createElement(UnreadDivider, { count: 3 }));
    expect(html).toContain('data-new-pill');
    expect(html).toContain('h-0.5');
    expect(html).not.toContain('3 unread</span>');
  });
});

describe('L8: a mention of me', () => {
  it('ink on fg at 12%, others unchanged', () => {
    expect(mentionClass(false, true)).toContain(MENTION_ME_PEER);
    expect(MENTION_ME_PEER).toBe('bg-fg/[.12] text-fg');
    expect(mentionClass(false, false)).toContain('text-accent-hover');
    expect(mentionClass(false, true)).not.toContain('outline');
  });
});

describe('L9: quick reactions', () => {
  it('👍 ✅ ❤️ 😂 🙏', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '✅', '❤️', '😂', '🙏']);
  });

  it('✅ never means approval: no approve path reads the reaction', () => {
    expect(read('../../../lib/chat/thread-signals.ts')).not.toContain('✅');
  });
});

describe('L10: the long-press sheet', () => {
  const base = {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    canAddToTasks: true,
    canMarkUnread: true,
    canCopyLink: true,
    canDelete: true,
  };

  it('three tiles, then Mark unread, Copy link, Copy text; Delete under More actions', () => {
    const items = messageMenuItems(base);
    expect(itemsOfGroup(items, 'tile').map((i) => i.label)).toEqual([
      'Reply',
      'Forward',
      ADD_TO_TASKS_LABEL,
    ]);
    expect(itemsOfGroup(items, 'row').map((i) => i.label)).toEqual([
      MARK_UNREAD_LABEL,
      COPY_LINK_LABEL,
      'Copy text',
    ]);
    expect(itemsOfGroup(items, 'more').map((i) => i.key)).toEqual(['delete']);
  });

  it('a tile is a big card target with the icon over the label', () => {
    const item = messageMenuItems(base)[0];
    if (item === undefined) throw new Error('no item');
    const html = renderToStaticMarkup(createElement(MenuTile, { item, onRun: () => {} }));
    expect(html).toContain('data-menu-tile');
    expect(html).toContain('min-h-18');
  });

  it('the phone sheet has a grab handle and no title; the laptop draws tiles as rows', () => {
    const src = read('../MessageActionMenu.tsx');
    expect(src).toContain('title="Message actions" handle');
    expect(src).toContain(
      'tiles.map((item) => <MenuRow key={item.key} item={item} onRun={run} />)',
    );
  });
});

describe('L12: Add to Tasks', () => {
  it('the text (first 280, capped by the table), else the file name', () => {
    expect(taskTitleOf({ body: 'Fix the *hook*', attachments: [] })).toBe('Fix the hook');
    expect(taskTitleOf({ body: 'x'.repeat(400), attachments: [] })).toHaveLength(
      TASK_FROM_MESSAGE_MAX,
    );
    expect(
      taskTitleOf({
        body: '',
        attachments: [
          { assetId: 'a', name: 'brief.pdf', mime: 'application/pdf', size: 1 } as never,
        ],
      }),
    ).toBe('brief.pdf');
  });
});

describe('L13: Copy link', () => {
  it('the open-chat-at-message route', () => {
    expect(chatMessageHref('c1', 'm1')).toBe('/chat?channel=c1&message=m1');
  });

  it('a jump to a thread reply opens its thread with the reply highlighted', () => {
    const src = read('../MessageThread.tsx') + read('../MessageBubble.tsx');
    expect(src).toContain('const mainJump = jumpIsReply ? null : jumpRequest;');
    expect(src).toContain('openThread(threadRootOf(jumpTarget));');
  });
});

describe('L11 / L14 wiring', () => {
  it('Reply (sheet, swipe right, right-click) opens the thread with its composer focused', () => {
    const src = read('../MessageThread.tsx') + read('../MessageBubble.tsx');
    expect(src).toContain('openThreadRef.current(threadRootOf(message), true);');
    expect(src).toContain('const onSwipeReply = useStableCallback(props.onReply);');
  });

  it('Mark unread routes main-chat messages and thread replies to their procs', () => {
    const src = read('../MessageThread.tsx') + read('../MessageBubble.tsx');
    expect(src).toContain(
      'markChatUnread({ client: supabase, channelId, messageId: message.id, traceId })',
    );
    expect(src).toContain('void markThreadUnread({');
  });
});

describe('Threads list: a card root names its row like its thread screen', () => {
  const thread = {
    rootId: 'root',
    replyCount: 1,
    lastReplyAt: '2026-11-08T11:00:00Z',
    lastReplyId: 'x',
    lastReplySender: 'leo',
    lastReplyBody: 'ok',
    unread: false,
  };
  const base = {
    threads: [thread],
    nameOf: (id: string | null) => PROFILES.get(id ?? '')?.displayName ?? 'Member',
    photoOf: () => undefined,
    now: new Date('2026-11-08T12:00:00Z'),
  };

  it('a card root with no text previews the card title, for every card kind', () => {
    const roots: ThreadMessage[] = [
      msg({ id: 'root', body: '', sharedPostIds: ['p1'] }),
      msg({ id: 'root', body: '', sharedBriefIds: ['b1'] }),
      msg({ id: 'root', body: '', sharedPlanIds: ['pl1'] }),
      msg({ id: 'root', body: '', sharedPlanItemIds: ['i1'] }),
    ];
    for (const root of roots) {
      const rows = threadsRows({
        ...base,
        rootOf: () => root,
        cardTitleOf: () => 'Pre & Post Diwali',
      });
      expect(rows[0]?.preview).toBe('Pre & Post Diwali');
    }
  });

  it('a card title not held yet falls back to the card label; a plain root never asks', () => {
    const plan = msg({ id: 'root', body: '', sharedPlanIds: ['pl1'] });
    const rows = threadsRows({ ...base, rootOf: () => plan, cardTitleOf: () => null });
    expect(rows[0]?.preview).toBe('Shared plan');
    const asked = vi.fn(() => 'never');
    const plain = msg({ id: 'root', body: 'Hello' });
    expect(threadsRows({ ...base, rootOf: () => plain, cardTitleOf: asked })[0]?.preview).toBe(
      'Hello',
    );
    expect(asked).not.toHaveBeenCalled();
  });

  it('a root not known yet is named "Thread"', () => {
    const rows = threadsRows({ ...base, rootOf: () => undefined });
    expect(rows[0]?.name).toBe(THREAD_TITLE);
  });
});
