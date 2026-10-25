import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MARKED_LOCKED_LABEL,
  MORE_REACTIONS_LABEL,
  QUICK_REACTIONS,
  ReactionsRow,
  markSubmenuItems,
  messageMenuItems,
  moreMenuItems,
  moreSubmenuItems,
  runMenuItem,
  nextWindowBoundaryMs,
  ownMessageActions,
  pickReaction,
  scheduleWindowBoundary,
  scrollFromPicker,
  menuClosesOnViewport,
  loadEmojiPicker,
  loadedEmojiPicker,
  resetEmojiPickerLoad,
  pickerInitialFocus,
  nextTrapFocus,
  returnPickerFocus,
  type EmojiPickerModule,
  type Focusable,
  type PickerRoot,
  type MessageMenuItem,
} from '@/components/chat/MessageActionMenu';
import { applyServerClock, initialState } from '@/lib/chat/chat-store';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';
import { ICON_SIZE, IconChevronRight } from '@/components/ui/icons';

type ItemProps = Parameters<typeof messageMenuItems>[0];

function labels(items: MessageMenuItem[]): string[] {
  return items.map((item) => item.label);
}

function itemProps(over: Partial<ItemProps> = {}): ItemProps {
  return {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    markOptions: ['commitment', 'decision', 'pending'],
    onMark: () => {},
    canForward: true,
    onForward: () => {},
    canSelectText: true,
    onSelectText: () => {},
    ...over,
  };
}

/** The top-level rows. */
function menu(over: Partial<ItemProps> = {}): string[] {
  return labels(messageMenuItems(itemProps(over)));
}

/** The rows under More. */
function more(over: Partial<ItemProps> = {}): string[] {
  return labels(moreMenuItems(itemProps(over)));
}

const NOW = Date.parse('2026-09-29T12:00:00Z');
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

function ago(minutes: number): Partial<ThreadMessage> {
  const createdAt = new Date(NOW - minutes * MIN).toISOString();
  return { createdAt, time: Date.parse(createdAt) };
}

const MARK: ChatMark = {
  messageId: 'm1',
  channelId: 'c1',
  type: 'decision',
  priority: null,
  markedAt: '2026-09-29T11:59:00Z',
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
};

/** The row set the menu shows for a message at NOW (mark options as the thread computes them). */
function propsFor(message: ThreadMessage, mark?: ChatMark): Partial<ItemProps> {
  const own = ownMessageActions(message, mark, NOW);
  return {
    canCopy: message.body.trim() !== '',
    canSelectText: message.state === 'sent' && message.body.trim() !== '',
    markOptions: mark === undefined ? ['commitment', 'decision', 'pending'] : [],
    markedAs: mark?.type ?? null,
    canEdit: own.canEdit,
    canDelete: own.canDelete,
    lockedByMark: own.lockedByMark,
  };
}

/** The top-level rows the menu shows for a message at NOW. */
function rowsFor(message: ThreadMessage, mark?: ChatMark): string[] {
  return menu(propsFor(message, mark));
}

/** The rows under More for a message at NOW. */
function moreRowsFor(message: ThreadMessage, mark?: ChatMark): string[] {
  return more(propsFor(message, mark));
}

describe('ownMessageActions: the edit and delete windows', () => {
  it('own within 15 min: Edit and Delete', () => {
    expect(ownMessageActions(msg(ago(5)), undefined, NOW)).toEqual({
      canEdit: true,
      canDelete: true,
      lockedByMark: false,
    });
    expect(ownMessageActions(msg(ago(15)), undefined, NOW).canEdit).toBe(true);
  });

  it('own at 20 min: Delete only; own at 40 min: neither', () => {
    expect(ownMessageActions(msg(ago(20)), undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: true,
      lockedByMark: false,
    });
    expect(ownMessageActions(msg(ago(40)), undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: false,
      lockedByMark: false,
    });
  });

  it('marked own: the locked line, never Edit or Delete', () => {
    expect(ownMessageActions(msg(ago(1)), MARK, NOW)).toEqual({
      canEdit: false,
      canDelete: false,
      lockedByMark: true,
    });
  });

  it('peer, pending (no created_at), failed and deleted: nothing', () => {
    const none = { canEdit: false, canDelete: false, lockedByMark: false };
    expect(ownMessageActions(msg({ mine: false }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ mine: false }), MARK, NOW)).toEqual(none);
    expect(
      ownMessageActions(
        msg({ createdAt: '', state: 'sending', provisionalTime: true }),
        undefined,
        NOW,
      ),
    ).toEqual(none);
    expect(ownMessageActions(msg({ createdAt: '' }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ state: 'failed' }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ deleted: true }), undefined, NOW)).toEqual(none);
  });

  it('Edit needs a body: a card or attachment only message can be deleted, not edited', () => {
    const cardOnly = msg({ body: '', sharedPostIds: ['p1'] });
    expect(ownMessageActions(cardOnly, undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: true,
      lockedByMark: false,
    });
  });

  it('notes: Edit and Delete have no window (Edit still needs a body)', () => {
    expect(ownMessageActions(msg(ago(40)), undefined, NOW, true)).toEqual({
      canEdit: true,
      canDelete: true,
      lockedByMark: false,
    });
    const blank = msg({ ...ago(40), body: ' ' });
    expect(ownMessageActions(blank, undefined, NOW, true).canEdit).toBe(false);
  });

  it('judges the window from the server created_at against the given moment', () => {
    const m = msg(ago(0));
    const created = Date.parse(m.createdAt);
    expect(ownMessageActions(m, undefined, created + EDIT_WINDOW_MS).canEdit).toBe(true);
    expect(ownMessageActions(m, undefined, created + EDIT_WINDOW_MS + 1).canEdit).toBe(false);
    expect(ownMessageActions(m, undefined, created + DELETE_WINDOW_MS).canDelete).toBe(true);
    expect(ownMessageActions(m, undefined, created + DELETE_WINDOW_MS + 1).canDelete).toBe(false);
  });
});

describe('moreMenuItems: Remind me', () => {
  it('sits directly before "Mark as"', () => {
    const rows = more({ canRemind: true, onRemind: () => {} });
    expect(rows.indexOf('Remind me')).toBe(rows.indexOf('Mark as') - 1);
  });

  it('sits directly before "Marked as <type>" on a marked message', () => {
    const rows = more({ markedAs: 'decision', canRemind: true, onRemind: () => {} });
    const marked = rows.findIndex((r) => r.startsWith('Marked as'));
    expect(rows[marked - 1]).toBe('Remind me');
  });

  it('is absent without the wiring', () => {
    expect(more()).not.toContain('Remind me');
    expect(menu({ canRemind: true, onRemind: () => {} })).not.toContain('Remind me');
  });
});

describe('messageMenuItems: row set per case', () => {
  it('own within 15 min', () => {
    expect(rowsFor(msg(ago(5)))).toEqual(['Reply', 'Copy', 'Forward', 'Edit', 'More', 'Delete']);
    expect(moreRowsFor(msg(ago(5)))).toEqual(['Select', 'Mark as']);
  });

  it('own at 20 min: no Edit', () => {
    expect(rowsFor(msg(ago(20)))).toEqual(['Reply', 'Copy', 'Forward', 'More', 'Delete']);
    expect(moreRowsFor(msg(ago(20)))).toEqual(['Select', 'Mark as']);
  });

  it('own at 40 min: neither Edit nor Delete', () => {
    expect(rowsFor(msg(ago(40)))).toEqual(['Reply', 'Copy', 'Forward', 'More']);
    expect(moreRowsFor(msg(ago(40)))).toEqual(['Select', 'Mark as']);
  });

  it('marked own: "Marked as <type>" under More and the single locked line last', () => {
    expect(rowsFor(msg(ago(2)), MARK)).toEqual([
      'Reply',
      'Copy',
      'Forward',
      'More',
      MARKED_LOCKED_LABEL,
    ]);
    expect(moreRowsFor(msg(ago(2)), MARK)).toEqual(['Select', 'Marked as Decision']);
  });

  it('peer: never Edit, Delete or the locked line', () => {
    expect(rowsFor(msg({ ...ago(1), mine: false }))).toEqual(['Reply', 'Copy', 'Forward', 'More']);
    expect(moreRowsFor(msg({ ...ago(1), mine: false }))).toEqual(['Select', 'Mark as']);
    expect(rowsFor(msg({ ...ago(1), mine: false }), MARK)).toEqual([
      'Reply',
      'Copy',
      'Forward',
      'More',
    ]);
    expect(moreRowsFor(msg({ ...ago(1), mine: false }), MARK)).toEqual([
      'Select',
      'Marked as Decision',
    ]);
  });

  it('the full order: top level, then the rows under More', () => {
    const all: Partial<ItemProps> = {
      canEdit: true,
      canDelete: true,
      canStar: true,
      canTranscribe: true,
      canSaveToNotes: true,
      canRemind: true,
      onRemind: () => {},
    };
    expect(menu(all)).toEqual(['Reply', 'Copy', 'Forward', 'Edit', 'Star', 'More', 'Delete']);
    expect(more(all)).toEqual(['Transcribe', 'Select', 'Save to notes', 'Remind me', 'Mark as']);
  });

  it('More is a submenu row, shown only when it has a row', () => {
    const item = messageMenuItems(itemProps()).find((i) => i.key === 'more');
    expect(item?.kind === 'action' && item.submenu).toBe(true);
    expect(menu({ canSelectText: false, markOptions: [] })).not.toContain('More');
  });

  it('More leads with the chevron, never the ⋯ glyph; the size flows to every icon', () => {
    const item = messageMenuItems(itemProps()).find((i) => i.key === 'more');
    const icon = item?.kind === 'action' ? (item.icon as ReactElement) : null;
    expect(icon?.type).toBe(IconChevronRight);
    for (const row of messageMenuItems(itemProps(), ICON_SIZE.inline)) {
      if (row.kind !== 'action') continue;
      expect((row.icon as ReactElement).props).toMatchObject({ size: ICON_SIZE.inline });
    }
    // By default every row (phone sheet and laptop popover) is at the tray size.
    for (const row of messageMenuItems(itemProps())) {
      if (row.kind !== 'action') continue;
      expect((row.icon as ReactElement).props).toMatchObject({ size: ICON_SIZE.tray });
    }
  });

  it('the More submenu is Back, then the rows under More', () => {
    const onBack = vi.fn();
    const items = moreSubmenuItems(itemProps(), onBack);
    expect(labels(items)).toEqual(['Back', 'Select', 'Mark as']);
    const back = items[0];
    if (back?.kind === 'action') back.run();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('runMenuItem: More opens its view and does not close', () => {
    const item = messageMenuItems(itemProps()).find((i) => i.key === 'more');
    const openMore = vi.fn();
    const openMark = vi.fn();
    const close = vi.fn();
    if (item !== undefined) runMenuItem(item, { openMark, openMore, close });
    expect(openMore).toHaveBeenCalledTimes(1);
    expect(openMark).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('pending: no Edit or Delete (no created_at)', () => {
    const pending = msg({ createdAt: '', state: 'sending', provisionalTime: true });
    const own = ownMessageActions(pending, undefined, NOW);
    expect(
      menu({
        canForward: false,
        markOptions: [],
        canEdit: own.canEdit,
        canDelete: own.canDelete,
        lockedByMark: own.lockedByMark,
        canSelectText: false,
      }),
    ).toEqual(['Reply', 'Copy']);
  });

  it('hides rows that do not apply (never greyed)', () => {
    expect(
      menu({ canForward: false, canCopy: false, markOptions: [], canSelectText: false }),
    ).toEqual(['Reply']);
  });

  it('the marked note and locked line are not interactive; Delete is danger with its hint', () => {
    const lockedProps: ItemProps = {
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      markedAs: 'commitment',
      lockedByMark: true,
    };
    expect(
      moreMenuItems(lockedProps)
        .filter((i) => i.kind === 'note')
        .map((i) => i.key),
    ).toEqual(['marked']);
    expect(
      messageMenuItems(lockedProps)
        .filter((i) => i.kind === 'note')
        .map((i) => i.key),
    ).toEqual(['locked']);
    const withDelete = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canEdit: true,
      canDelete: true,
    });
    const edit = withDelete.find((i) => i.key === 'edit');
    const del = withDelete.find((i) => i.key === 'delete');
    expect(edit?.kind === 'action' && edit.hint).toBe('15 min');
    expect(del?.kind === 'action' && del.hint).toBe('30 min');
    expect(del?.kind === 'action' && del.danger).toBe(true);
    const inNotes = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canEdit: true,
      canDelete: true,
      notes: true,
    });
    const noteEdit = inNotes.find((i) => i.key === 'edit');
    const noteDel = inNotes.find((i) => i.key === 'delete');
    expect(noteEdit?.kind === 'action' && noteEdit.hint).toBeUndefined();
    expect(noteDel?.kind === 'action' && noteDel.hint).toBeUndefined();
    expect(inNotes[inNotes.length - 1]?.key).toBe('delete');
  });

  it('runs the forward, edit and delete handlers', () => {
    const onForward = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const items = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canForward: true,
      onForward,
      canEdit: true,
      onEdit,
      canDelete: true,
      onDelete,
    });
    for (const key of ['forward', 'edit', 'delete']) {
      const item = items.find((i) => i.key === key);
      if (item?.kind === 'action') item.run();
    }
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('Mark as submenu', () => {
  it('Back, then Commitment, Decision, Pending, each with its colour dot', () => {
    const onBack = vi.fn();
    const onMark = vi.fn();
    const items = markSubmenuItems(
      { markOptions: ['commitment', 'decision', 'pending'], onMark },
      onBack,
    );
    expect(labels(items)).toEqual(['Back', 'Commitment', 'Decision', 'Pending']);
    expect(items.map((i) => (i.kind === 'action' ? i.dot : undefined))).toEqual([
      undefined,
      'commitment',
      'decision',
      'pending',
    ]);
    for (const item of items) if (item.kind === 'action') item.run();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onMark.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'commitment',
      'decision',
      'pending',
    ]);
  });

  it('the main row opens the submenu (no run, no close)', () => {
    const item = moreMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      markOptions: ['pending'],
    }).find((i) => i.key === 'mark');
    expect(item?.kind === 'action' && item.submenu).toBe(true);
  });
});

describe('QUICK_REACTIONS', () => {
  it('is exactly the approved quick-react set, in order, followed by the "+"', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '❤️', '😂', '👌', '🙏']);
    const buttons = rowButtons(row());
    expect(buttons.map((b) => b.props['aria-label'])).toEqual([
      ...QUICK_REACTIONS.map((e) => `React ${e}`),
      MORE_REACTIONS_LABEL,
    ]);
  });
});

/** Every element in a tree (hook-free components only are expanded). */
function all(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

function row(
  over: Partial<Parameters<typeof ReactionsRow>[0]> = {},
): ReturnType<typeof ReactionsRow> {
  return ReactionsRow({
    currentReaction: null,
    reactionsOnly: false,
    onReact: () => {},
    onMore: () => {},
    ...over,
  });
}

/** The rendered <button>s: the row's IconButtons are expanded to the button each renders. */
function rowButtons(el: ReactElement): ReactElement<Record<string, unknown>>[] {
  return all(el).flatMap((e) => {
    if (typeof e.type === 'function') {
      return rowButtons((e.type as (p: unknown) => ReactElement)(e.props));
    }
    return e.type === 'button' ? [e as ReactElement<Record<string, unknown>>] : [];
  });
}

describe('D6: the reactions row and its "+"', () => {
  it('six 44x44 controls: the five quick reactions, then "+"', () => {
    const buttons = rowButtons(row());
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(String(b.props.className)).toContain('h-11');
      expect(String(b.props.className)).toContain('w-11');
    }
    expect(buttons[5]?.props['data-react-more']).toBe('');
  });

  it('"+" opens the picker; a quick reaction reacts', () => {
    const onMore = vi.fn();
    const onReact = vi.fn();
    const buttons = rowButtons(row({ onMore, onReact }));
    (buttons[5]?.props.onClick as () => void)();
    expect(onMore).toHaveBeenCalledOnce();
    expect(onReact).not.toHaveBeenCalled();
    (buttons[0]?.props.onClick as () => void)();
    expect(onReact).toHaveBeenCalledWith('👍');
  });

  it('the laptop smiley row (reactionsOnly) carries the "+" too, as a focus stop', () => {
    const buttons = rowButtons(row({ reactionsOnly: true }));
    expect(buttons).toHaveLength(6);
    expect(buttons[5]?.props['data-menu-item']).toBe('react-more');
  });

  it('a pick reacts once through the same path, then closes the picker and the menu', () => {
    const order: string[] = [];
    const onReact = vi.fn((emoji: string) => order.push(`react ${emoji}`));
    pickReaction('🦄', {
      onReact,
      closePicker: () => order.push('close picker'),
      closeMenu: () => order.push('close menu'),
    });
    expect(onReact).toHaveBeenCalledOnce();
    expect(order).toEqual(['react 🦄', 'close picker', 'close menu']);
  });

  it("the picker grid's own scroll never closes the menu", () => {
    expect(scrollFromPicker(null)).toBe(false);
  });
});

describe('D3: window visibility on server time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the server clock offset: a device clock 10 min behind still hides Edit at 16 server-min', () => {
    const deviceNow = NOW;
    const created = new Date(NOW - 6 * MIN).toISOString();
    // The ack showed the server 10 minutes ahead of this device.
    const offset = applyServerClock(
      initialState(),
      new Date(NOW + 10 * MIN).toISOString(),
      NOW,
    ).serverClockOffsetMs;
    expect(offset).toBe(10 * MIN);
    const onDevice = ownMessageActions(msg({ createdAt: created }), undefined, deviceNow);
    const onServer = ownMessageActions(msg({ createdAt: created }), undefined, deviceNow + offset);
    expect(onDevice.canEdit).toBe(true);
    expect(onServer.canEdit).toBe(false);
    expect(onServer.canDelete).toBe(true);
  });

  it('the next boundary is 15 min, then 30 min, then none', () => {
    const created = new Date(NOW - 5 * MIN).toISOString();
    expect(nextWindowBoundaryMs(created, NOW)).toBe(10 * MIN + 1);
    expect(nextWindowBoundaryMs(created, NOW + 10 * MIN + 1)).toBe(15 * MIN);
    expect(nextWindowBoundaryMs(created, NOW + 25 * MIN + 1)).toBeNull();
    expect(nextWindowBoundaryMs('', NOW)).toBeNull();
  });

  it('while open, re-computes the rows at 15 and at 30 min (one timeout at a time, no interval)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offset = 2 * MIN;
    const serverNow = (): number => Date.now() + offset;
    // Created 5 server-minutes ago.
    const message = msg({ createdAt: new Date(serverNow() - 5 * MIN).toISOString() });
    let rows = ownMessageActions(message, undefined, serverNow());
    const recomputed: string[] = [];
    let cancel = (): void => {};
    const arm = (): void => {
      cancel = scheduleWindowBoundary({
        createdAt: message.createdAt,
        now: serverNow,
        onBoundary: () => {
          rows = ownMessageActions(message, undefined, serverNow());
          recomputed.push(`${rows.canEdit ? 'edit' : '-'} ${rows.canDelete ? 'delete' : '-'}`);
          arm(); // the menu re-schedules from its new moment
        },
      });
    };
    arm();
    expect(rows).toMatchObject({ canEdit: true, canDelete: true });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10 * MIN);
    expect(recomputed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(recomputed).toEqual(['- delete']);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15 * MIN);
    expect(recomputed).toEqual(['- delete', '- -']);
    expect(vi.getTimerCount()).toBe(0);
    cancel();
  });

  it('closing the menu clears the timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onBoundary = vi.fn();
    const cancel = scheduleWindowBoundary({
      createdAt: new Date(NOW - 5 * MIN).toISOString(),
      now: () => Date.now(),
      onBoundary,
    });
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    expect(onBoundary).not.toHaveBeenCalled();
  });
});

describe('F4: the picker never closes itself', () => {
  it('a resize or scroll while the picker is open does not close the menu (so not the picker)', () => {
    expect(menuClosesOnViewport('resize', { picking: true, target: null })).toBe(false);
    expect(menuClosesOnViewport('scroll', { picking: true, target: null })).toBe(false);
    // Without the picker: any resize and any scroll outside it still close the menu.
    expect(menuClosesOnViewport('resize', { picking: false, target: null })).toBe(true);
    expect(menuClosesOnViewport('scroll', { picking: false, target: null })).toBe(true);
  });
});

describe('F3: the picker chunk loads once, on menu open', () => {
  afterEach(() => resetEmojiPickerLoad());

  it('one import however often it is asked for; the module is then ready synchronously', async () => {
    const module = { EmojiPickerPanel: () => null } as unknown as EmojiPickerModule;
    const importer = vi.fn(() => Promise.resolve(module));
    expect(loadedEmojiPicker()).toBeNull();
    await Promise.all([loadEmojiPicker(importer), loadEmojiPicker(importer)]);
    expect(importer).toHaveBeenCalledOnce();
    expect(loadedEmojiPicker()).toBe(module);
  });

  it('a failed load is forgotten, so the next open tries again', async () => {
    const importer = vi.fn(() => Promise.reject(new Error('chunk')));
    await expect(loadEmojiPicker(importer)).rejects.toThrow('chunk');
    await expect(loadEmojiPicker(importer)).rejects.toThrow('chunk');
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

describe('F5: picker focus', () => {
  function root(): PickerRoot & { focused: string[] } {
    const focused: string[] = [];
    const search: Focusable = { focus: () => focused.push('search') };
    return {
      focused,
      focus: () => focused.push('sheet'),
      querySelector: (selector) => (selector === '[data-emoji-search]' ? search : null),
    };
  }

  it('laptop: initial focus on the search field; touch: on the sheet, never the search field', () => {
    const laptop = root();
    pickerInitialFocus('laptop', laptop).focus();
    expect(laptop.focused).toEqual(['search']);
    const touch = root();
    pickerInitialFocus('touch', touch).focus();
    expect(touch.focused).toEqual(['sheet']);
  });

  it('laptop before the body arrives: the shell holds focus until the search field exists', () => {
    const shell: PickerRoot & { focused: boolean } = {
      focused: false,
      focus: () => {
        shell.focused = true;
      },
      querySelector: () => null,
    };
    pickerInitialFocus('laptop', shell).focus();
    expect(shell.focused).toBe(true);
  });

  it('Tab is trapped inside: it wraps at both ends, and enters from the container', () => {
    const items = ['close', 'search', 'tab1', 'glyph'];
    expect(nextTrapFocus(items, 'glyph', false)).toBe('close');
    expect(nextTrapFocus(items, 'close', true)).toBe('glyph');
    expect(nextTrapFocus(items, 'search', false)).toBe('tab1');
    expect(nextTrapFocus(items, null, false)).toBe('close');
    expect(nextTrapFocus(items, 'outside', true)).toBe('glyph');
    expect(nextTrapFocus([], null, false)).toBeNull();
  });

  it('on close, focus returns to "+" (skipped when "+" left with the menu)', () => {
    const plus = { isConnected: true, focus: vi.fn() };
    expect(returnPickerFocus(plus)).toBe(true);
    expect(plus.focus).toHaveBeenCalledOnce();
    expect(returnPickerFocus({ isConnected: false, focus: vi.fn() })).toBe(false);
    expect(returnPickerFocus(null)).toBe(false);
  });

  it('the "+" carries the ref the picker returns focus to', () => {
    const moreRef = { current: null };
    const row = ReactionsRow({
      currentReaction: null,
      reactionsOnly: false,
      onReact: () => {},
      onMore: () => {},
      moreRef,
    });
    const plus = (row.props.children as ReactNode[])
      .flat()
      .find(
        (el) =>
          isValidElement(el) &&
          (el.props as Record<string, unknown>)['data-react-more'] !== undefined,
      ) as ReactElement<{ buttonRef?: unknown }>;
    // An IconButton: the ref travels as buttonRef.
    expect(plus.props.buttonRef).toBe(moreRef);
  });
});

describe('moreMenuItems: Transcribe', () => {
  it('shows Transcribe first under More for a voice note (no Copy row: the body is empty)', () => {
    const voice = {
      canCopy: false,
      canSelectText: false,
      canTranscribe: true,
      onTranscribe: () => {},
    };
    expect(menu(voice)).toEqual(['Reply', 'Forward', 'More']);
    expect(more(voice)).toEqual(['Transcribe', 'Mark as']);
  });

  it('hides Transcribe when not offered (loading, or a transcript exists)', () => {
    expect(more({ canCopy: false, canTranscribe: false })).not.toContain('Transcribe');
    expect(more({ canCopy: false })).not.toContain('Transcribe');
    expect(menu({ canCopy: false, canTranscribe: true })).not.toContain('Transcribe');
  });

  it('runs onTranscribe', () => {
    const onTranscribe = vi.fn();
    const item = moreMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canTranscribe: true,
      onTranscribe,
    }).find((i) => i.kind === 'action' && i.key === 'transcribe');
    expect(item?.kind).toBe('action');
    if (item?.kind === 'action') item.run();
    expect(onTranscribe).toHaveBeenCalledOnce();
  });
});
