import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  computeMenuPlacement,
  heldTransform,
  MENU_ICON_SIZE,
  MENU_PANEL,
  MENU_ROW,
  MENU_WIDTH_PX,
  MenuRow,
  messageMenuItems,
  moreMenuItems,
  ownMessageActions,
  ReactionsRow,
  visibleViewportHeight,
  type MessageMenuItem,
} from '@/components/chat/MessageActionMenu';
import { canSelectMessageText } from '@/components/chat/MessageThread';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';

// Banned literals assembled from parts (chat-tokens.test.ts scans this folder).
const DARK = ['dark', ':'].join('');
const HASH = String.fromCharCode(35);

const NOW = Date.parse('2026-10-05T12:00:00Z');
const MIN = 60 * 1000;

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = new Date(NOW - 5 * MIN).toISOString();
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'hello',
    createdAt,
    time: Date.parse(createdAt),
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

const VOICE = {
  id: 'a1',
  name: 'voice.m4a',
  mime: 'audio/mp4',
  size: 1000,
} as unknown as ThreadMessage['attachments'][number];
const PHOTO = {
  id: 'a2',
  name: 'p.jpg',
  mime: 'image/jpeg',
  size: 1000,
} as unknown as ThreadMessage['attachments'][number];

const MARK: ChatMark = {
  messageId: 'm1',
  channelId: 'c1',
  type: 'decision',
  priority: null,
  markedAt: '2026-10-05T11:59:00Z',
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
};

type KeyOpts = { mark?: ChatMark; notes?: boolean; transcribe?: boolean };

/** The menu wiring for a message, as ThreadBody passes it. */
function propsFor(
  message: ThreadMessage,
  opts: KeyOpts = {},
): Parameters<typeof messageMenuItems>[0] {
  const own = ownMessageActions(message, opts.mark, NOW, opts.notes === true);
  return {
    canCopy: message.body.trim() !== '',
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    canTranscribe: opts.transcribe === true,
    canSelectText: canSelectMessageText(message),
    canStar: true,
    canSaveToNotes: opts.notes !== true,
    canRemind: true,
    markOptions: opts.notes === true || opts.mark !== undefined ? [] : ['decision'],
    markedAs: opts.mark?.type ?? null,
    canEdit: own.canEdit,
    canDelete: own.canDelete,
    lockedByMark: own.lockedByMark,
    notes: opts.notes === true,
  };
}

/** The top-level keys the thread's menu shows for a message. */
function keysFor(message: ThreadMessage, opts: KeyOpts = {}): string[] {
  return messageMenuItems(propsFor(message, opts)).map((item) => item.key);
}

/** The keys under More for a message. */
function moreKeysFor(message: ThreadMessage, opts: KeyOpts = {}): string[] {
  return moreMenuItems(propsFor(message, opts)).map((item) => item.key);
}

describe('menu order', () => {
  it('mine: Reply / Copy / Forward / Edit / Star / More / Delete', () => {
    expect(keysFor(msg())).toEqual(['reply', 'copy', 'forward', 'edit', 'star', 'more', 'delete']);
  });

  it('mine, under More: Select / Save / Remind / Mark', () => {
    expect(moreKeysFor(msg())).toEqual(['select-text', 'save-notes', 'remind', 'mark']);
  });

  it('theirs: no Edit or Delete', () => {
    expect(keysFor(msg({ mine: false }))).toEqual(['reply', 'copy', 'forward', 'star', 'more']);
    expect(moreKeysFor(msg({ mine: false }))).toEqual([
      'select-text',
      'save-notes',
      'remind',
      'mark',
    ]);
  });

  it('voice only: Transcribe under More, no Copy and no Select', () => {
    const voice = msg({ mine: false, body: '', attachments: [VOICE] });
    expect(keysFor(voice, { transcribe: true })).toEqual(['reply', 'forward', 'star', 'more']);
    expect(moreKeysFor(voice, { transcribe: true })).toEqual([
      'transcribe',
      'save-notes',
      'remind',
      'mark',
    ]);
  });

  it('photo with a caption and a post card with a body offer Select', () => {
    expect(moreKeysFor(msg({ mine: false, body: 'look', attachments: [PHOTO] }))).toContain(
      'select-text',
    );
    expect(moreKeysFor(msg({ mine: false, body: 'this one', sharedPostIds: ['p1'] }))).toContain(
      'select-text',
    );
  });

  it('bare photo and bare post card: no Select', () => {
    expect(moreKeysFor(msg({ mine: false, body: '', attachments: [PHOTO] }))).not.toContain(
      'select-text',
    );
    expect(moreKeysFor(msg({ mine: false, body: ' ', sharedPostIds: ['p1'] }))).not.toContain(
      'select-text',
    );
  });

  it('marked own: Remind me before "Marked as" under More, the locked line last', () => {
    expect(keysFor(msg(), { mark: MARK })).toEqual([
      'reply',
      'copy',
      'forward',
      'star',
      'more',
      'locked',
    ]);
    expect(moreKeysFor(msg(), { mark: MARK })).toEqual([
      'select-text',
      'save-notes',
      'remind',
      'marked',
    ]);
  });

  it('notes: no Mark as or Save to notes; Edit and Delete without a window', () => {
    const old = msg({ createdAt: new Date(NOW - 90 * MIN).toISOString() });
    expect(keysFor(old, { notes: true })).toEqual([
      'reply',
      'copy',
      'forward',
      'edit',
      'star',
      'more',
      'delete',
    ]);
    expect(moreKeysFor(old, { notes: true })).toEqual(['select-text', 'remind']);
  });

  it('Remind me sits right before Mark as', () => {
    const keys = moreKeysFor(msg({ mine: false }));
    expect(keys.indexOf('remind')).toBe(keys.indexOf('mark') - 1);
  });

  it('the old multi-select row and its divider are gone; no NEW badge', () => {
    const props = {
      canCopy: true,
      onReply: () => {},
      onCopy: () => {},
      canSelectText: true,
    };
    const items = [...messageMenuItems(props), ...moreMenuItems(props)];
    expect(items.map((i) => i.key)).not.toContain('select');
    expect(items.map((i) => i.key)).not.toContain('select-divider');
    expect(items.every((i) => i.kind === 'action' || i.kind === 'note')).toBe(true);
    expect(JSON.stringify(items.map((i) => i.label))).not.toMatch(/new/i);
  });

  it('Edit and Delete keep their window hints, shown only while the window is open', () => {
    expect(keysFor(msg({ createdAt: new Date(NOW - 20 * MIN).toISOString() }))).not.toContain(
      'edit',
    );
    expect(keysFor(msg({ createdAt: new Date(NOW - 40 * MIN).toISOString() }))).not.toContain(
      'delete',
    );
  });
});

describe('canSelectMessageText', () => {
  it('sent, live, typed body, not voice only', () => {
    expect(canSelectMessageText(msg())).toBe(true);
    expect(
      canSelectMessageText(msg({ reply: { id: 'x', preview: 'q', authorUserId: 'p' } } as never)),
    ).toBe(true);
    expect(canSelectMessageText(msg({ forwarded: true }))).toBe(true);
    expect(canSelectMessageText(msg({ state: 'sending' }))).toBe(false);
    expect(canSelectMessageText(msg({ state: 'failed' }))).toBe(false);
    expect(canSelectMessageText(msg({ deleted: true }))).toBe(false);
    expect(canSelectMessageText(msg({ body: '   ' }))).toBe(false);
    expect(canSelectMessageText(msg({ body: '', attachments: [VOICE] }))).toBe(false);
  });
});

function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

describe('menu style', () => {
  const styleProps: Parameters<typeof messageMenuItems>[0] = {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    canSelectText: true,
    canStar: true,
    starred: true,
    canSaveToNotes: true,
    canRemind: true,
    markOptions: ['decision'],
    canEdit: true,
    canDelete: true,
  };
  const items = [...messageMenuItems(styleProps), ...moreMenuItems(styleProps)];

  it('panel: 18px radius, border-border hairline, no inner padding, tokens only', () => {
    const cls = MENU_PANEL.split(' ');
    expect(cls).toEqual(expect.arrayContaining(['rounded-[18px]', 'border', 'border-border']));
    expect(cls).toEqual(expect.arrayContaining(['bg-panel', 'shadow-2xl']));
    expect(cls).not.toContain('border-border-strong');
    expect(cls.some((c) => /^p-/.test(c))).toBe(false);
    expect(MENU_PANEL).not.toContain(DARK);
    expect(MENU_PANEL).not.toContain(HASH);
    // Six 44px reaction cells, the row's 10px sides and the 1px border each side.
    expect(MENU_WIDTH_PX).toBeGreaterThanOrEqual(6 * 44 + 20 + 2);
  });

  it('rows: full-bleed, >= 44px, 16px sides, 14px gap, 16px fg text', () => {
    const cls = MENU_ROW.split(' ');
    expect(cls).toEqual(expect.arrayContaining(['min-h-[44px]', 'px-4', 'gap-[14px]']));
    const html = renderToStaticMarkup(
      <>
        {items.map((item) => (
          <MenuRow key={item.key} item={item} onRun={() => {}} />
        ))}
      </>,
    );
    expect(html).not.toContain('rounded-lg');
    expect(html).not.toContain('text-fg-2');
    expect(html).toContain('text-[16px]');
    expect(html).not.toContain(DARK);
    expect(html).not.toContain(HASH);
  });

  it('icons: 22px, stroke 1.7, inherit the row ink; Delete in bad', () => {
    for (const item of items) {
      let sizes: unknown[] = [];
      walk(item.icon, (el) => {
        const size = (el.props as { size?: unknown }).size;
        if (size !== undefined) sizes = [...sizes, size];
      });
      expect(sizes, item.key).toEqual([MENU_ICON_SIZE]);
    }
    const html = renderToStaticMarkup(
      <MenuRow item={items.find((i) => i.key === 'copy') as MessageMenuItem} onRun={() => {}} />,
    );
    expect(html).toContain('stroke-width="1.7"');
    expect(html).toContain('width="22"');
    expect(html).toMatch(/class="[^"]*text-fg[ "]/);
    const del = renderToStaticMarkup(
      <MenuRow item={items.find((i) => i.key === 'delete') as MessageMenuItem} onRun={() => {}} />,
    );
    expect(del).toContain('text-bad');
  });

  it('icon mapping: Select crop, filled star when starred, note page, bookmark', () => {
    const html = (key: string): string =>
      renderToStaticMarkup(
        <MenuRow item={items.find((i) => i.key === key) as MessageMenuItem} onRun={() => {}} />,
      );
    expect(html('select-text')).toContain('M6 6.5V16a1 1 0 0 0 1 1h10.5');
    expect(html('star')).toContain('fill="currentColor"');
    expect(html('save-notes')).toContain('M6 3h9l4 4v14H6z');
    expect(html('mark')).toContain('M6 3h12v18l-6-4-6 4z');
  });

  it('reactions: six 44x44 cells, 8px 10px padding, one hairline under it', () => {
    const html = renderToStaticMarkup(
      <ReactionsRow
        currentReaction={null}
        reactionsOnly={false}
        onReact={() => {}}
        onMore={() => {}}
      />,
    );
    expect(html.match(/h-11 w-11 shrink-0/g)?.length).toBe(6);
    expect(html).toContain('px-[10px] py-2');
    expect(html).toContain('border-b border-border');
  });
});

describe('computeMenuPlacement', () => {
  const base = { safeTop: 0, safeBottom: 0, gap: 8, margin: 8 };

  it('room below: no shift, menu 8px under the bubble', () => {
    expect(
      computeMenuPlacement({
        ...base,
        bubbleRect: { top: 100, bottom: 160 },
        menuHeight: 400,
        viewportHeight: 844,
      }),
    ).toEqual({ bubbleShiftY: 0, menuTop: 168, clipBubbleHeight: undefined });
  });

  it('near the bottom: the copy moves up by the shortfall, menu still below', () => {
    const p = computeMenuPlacement({
      ...base,
      bubbleRect: { top: 700, bottom: 760 },
      menuHeight: 400,
      viewportHeight: 844,
    });
    // 760 + 8 + 400 = 1168 > 836: shift 332.
    expect(p.bubbleShiftY).toBe(-332);
    expect(p.menuTop).toBe(760 - 332 + 8);
    expect(p.menuTop + 400).toBeLessThanOrEqual(844 - 8);
    expect(p.clipBubbleHeight).toBeUndefined();
  });

  it('tall bubble: clipped to the room left, top at safeTop + 8, menu right under it', () => {
    const p = computeMenuPlacement({
      ...base,
      safeTop: 47,
      safeBottom: 34,
      bubbleRect: { top: 300, bottom: 900 },
      menuHeight: 450,
      viewportHeight: 844,
    });
    expect(p.bubbleShiftY).toBe(55 - 300);
    const floor = 844 - 34 - 8;
    expect(p.clipBubbleHeight).toBe(floor - 450 - 8 - 55);
    expect(p.menuTop).toBe(55 + (p.clipBubbleHeight ?? 0) + 8);
    expect(p.menuTop + 450).toBe(floor);
  });

  it('keyboard open: the visual viewport is shorter, so the copy moves further up', () => {
    const full = computeMenuPlacement({
      ...base,
      bubbleRect: { top: 300, bottom: 360 },
      menuHeight: 400,
      viewportHeight: 844,
    });
    const keyboard = computeMenuPlacement({
      ...base,
      bubbleRect: { top: 300, bottom: 360 },
      menuHeight: 400,
      viewportHeight: visibleViewportHeight({
        innerHeight: 844,
        visualViewport: { height: 500, offsetTop: 0 },
      }),
    });
    expect(full.bubbleShiftY).toBe(0);
    expect(keyboard.bubbleShiftY).toBe(-(360 + 8 + 400 - 492));
    expect(keyboard.menuTop + 400).toBeLessThanOrEqual(492);
    expect(visibleViewportHeight({ innerHeight: 700 })).toBe(700);
  });

  it('never above the bubble, never shifted down, for any bubble position', () => {
    for (let top = -100; top <= 900; top += 37) {
      for (const height of [20, 80, 300, 700]) {
        for (const menuHeight of [120, 300, 520]) {
          const p = computeMenuPlacement({
            ...base,
            safeTop: 20,
            safeBottom: 20,
            bubbleRect: { top, bottom: top + height },
            menuHeight,
            viewportHeight: 844,
          });
          const copyTop = top + p.bubbleShiftY;
          const copyBottom = copyTop + (p.clipBubbleHeight ?? height);
          expect(p.bubbleShiftY).toBeLessThanOrEqual(0);
          expect(p.menuTop).toBeGreaterThanOrEqual(copyBottom + 8 - 1e-9);
        }
      }
    }
  });

  it('the copy moves on Y only', () => {
    expect(heldTransform(-120)).toBe('translateY(-120px)');
    expect(heldTransform(0)).not.toMatch(/scale|rotate|translateX/);
  });
});
