import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MORE_REACTIONS_LABEL,
  QUICK_REACTIONS,
  ReactionsRow,
  dividerBefore,
  messageMenuItems,
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
import type { ThreadMessage } from '@/lib/chat/thread';
import { ICON_SIZE } from '@/components/ui/icons';

type ItemProps = Parameters<typeof messageMenuItems>[0];

function labels(items: MessageMenuItem[]): string[] {
  return items.map((item) => item.label);
}

function itemProps(over: Partial<ItemProps> = {}): ItemProps {
  return {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    onForward: () => {},
    canSelectText: true,
    onSelectText: () => {},
    ...over,
  };
}

/** The rows, one level. */
function menu(over: Partial<ItemProps> = {}): string[] {
  return labels(messageMenuItems(itemProps(over)));
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

/** The row set the menu shows for a message at NOW. */
function rowsFor(message: ThreadMessage): string[] {
  const own = ownMessageActions(message, NOW);
  return menu({
    canCopy: message.body.trim() !== '',
    canSelectText: message.state === 'sent' && message.body.trim() !== '',
    canEdit: own.canEdit,
    canDelete: own.canDelete,
  });
}

describe('ownMessageActions: the edit and delete windows', () => {
  it('own within 15 min: Edit and Delete', () => {
    expect(ownMessageActions(msg(ago(5)), NOW)).toEqual({ canEdit: true, canDelete: true });
    expect(ownMessageActions(msg(ago(15)), NOW).canEdit).toBe(true);
  });

  it('own at 20 min: Delete only; own at 40 min: neither', () => {
    expect(ownMessageActions(msg(ago(20)), NOW)).toEqual({ canEdit: false, canDelete: true });
    expect(ownMessageActions(msg(ago(40)), NOW)).toEqual({ canEdit: false, canDelete: false });
  });

  it('peer, pending (no created_at), failed and deleted: nothing', () => {
    const none = { canEdit: false, canDelete: false };
    expect(ownMessageActions(msg({ mine: false }), NOW)).toEqual(none);
    expect(
      ownMessageActions(msg({ createdAt: '', state: 'sending', provisionalTime: true }), NOW),
    ).toEqual(none);
    expect(ownMessageActions(msg({ createdAt: '' }), NOW)).toEqual(none);
    expect(ownMessageActions(msg({ state: 'failed' }), NOW)).toEqual(none);
    expect(ownMessageActions(msg({ deleted: true }), NOW)).toEqual(none);
  });

  it('Edit needs a body: a card or attachment only message can be deleted, not edited', () => {
    const cardOnly = msg({ body: '', sharedPostIds: ['p1'] });
    expect(ownMessageActions(cardOnly, NOW)).toEqual({ canEdit: false, canDelete: true });
  });

  it('notes: Edit and Delete have no window (Edit still needs a body)', () => {
    expect(ownMessageActions(msg(ago(40)), NOW, true)).toEqual({ canEdit: true, canDelete: true });
    const blank = msg({ ...ago(40), body: ' ' });
    expect(ownMessageActions(blank, NOW, true).canEdit).toBe(false);
  });

  it('judges the window from the server created_at against the given moment', () => {
    const m = msg(ago(0));
    const created = Date.parse(m.createdAt);
    expect(ownMessageActions(m, created + EDIT_WINDOW_MS).canEdit).toBe(true);
    expect(ownMessageActions(m, created + EDIT_WINDOW_MS + 1).canEdit).toBe(false);
    expect(ownMessageActions(m, created + DELETE_WINDOW_MS).canDelete).toBe(true);
    expect(ownMessageActions(m, created + DELETE_WINDOW_MS + 1).canDelete).toBe(false);
  });
});

describe('messageMenuItems: one level, row set per case', () => {
  it('own within 15 min', () => {
    expect(rowsFor(msg(ago(5)))).toEqual(['Reply', 'Copy', 'Select', 'Forward', 'Edit', 'Delete']);
  });

  it('own at 20 min: no Edit', () => {
    expect(rowsFor(msg(ago(20)))).toEqual(['Reply', 'Copy', 'Select', 'Forward', 'Delete']);
  });

  it('own at 40 min: neither Edit nor Delete', () => {
    expect(rowsFor(msg(ago(40)))).toEqual(['Reply', 'Copy', 'Select', 'Forward']);
  });

  it('peer: never Edit or Delete', () => {
    expect(rowsFor(msg({ ...ago(1), mine: false }))).toEqual([
      'Reply',
      'Copy',
      'Select',
      'Forward',
    ]);
  });

  it('the full order: Reply .. Edit, then Remove file and Delete last', () => {
    const all: Partial<ItemProps> = {
      canReplyPrivately: true,
      replyPrivatelyName: 'Priya Shah',
      canTranscribe: true,
      canSaveToNotes: true,
      canEdit: true,
      canRemoveFile: true,
      canDelete: true,
    };
    expect(messageMenuItems(itemProps(all)).map((i) => i.key)).toEqual([
      'reply',
      'reply-privately',
      'copy',
      'select-text',
      'transcribe',
      'forward',
      'save-notes',
      'edit',
      'remove-file',
      'delete',
    ]);
  });

  it('no More row and no Back row, ever', () => {
    const keys = messageMenuItems(
      itemProps({ canTranscribe: true, canSaveToNotes: true, canRemoveFile: true }),
    ).map((i) => i.key);
    expect(keys).not.toContain('more');
    expect(keys).not.toContain('back');
  });

  it('the size flows to every icon', () => {
    const items = messageMenuItems(itemProps({ canEdit: true, canDelete: true }), 18);
    for (const item of items) {
      const icon = item.icon as ReactElement<{ size?: number }>;
      expect(icon.props.size).toBe(18);
    }
    const sized = messageMenuItems(itemProps());
    expect((sized[0]?.icon as ReactElement<{ size?: number }>).props.size).toBe(ICON_SIZE.tray);
  });

  it('runMenuItem runs the row, then closes', () => {
    const order: string[] = [];
    const item = messageMenuItems(itemProps({ onReply: () => order.push('run') }))[0];
    if (item !== undefined) runMenuItem(item, { close: () => order.push('close') });
    expect(order).toEqual(['run', 'close']);
  });

  it('pending: no Edit or Delete (no created_at)', () => {
    const pending = msg({ createdAt: '', state: 'sending', provisionalTime: true });
    const own = ownMessageActions(pending, NOW);
    expect(
      menu({
        canForward: false,
        canEdit: own.canEdit,
        canDelete: own.canDelete,
        canSelectText: false,
      }),
    ).toEqual(['Reply', 'Copy']);
  });

  it('hides rows that do not apply (never greyed)', () => {
    expect(menu({ canForward: false, canCopy: false, canSelectText: false })).toEqual(['Reply']);
  });

  it('Edit and Delete keep their hints; Remove file and Delete are danger', () => {
    const withDelete = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canEdit: true,
      canRemoveFile: true,
      canDelete: true,
    });
    const edit = withDelete.find((i) => i.key === 'edit');
    const remove = withDelete.find((i) => i.key === 'remove-file');
    const del = withDelete.find((i) => i.key === 'delete');
    expect(edit?.hint).toBe('15 min');
    expect(del?.hint).toBe('30 min');
    expect(remove?.danger).toBe(true);
    expect(del?.danger).toBe(true);
    expect(edit?.danger).toBeUndefined();
    const inNotes = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canEdit: true,
      canDelete: true,
      notes: true,
    });
    expect(inNotes.find((i) => i.key === 'edit')?.hint).toBeUndefined();
    expect(inNotes.find((i) => i.key === 'delete')?.hint).toBeUndefined();
    expect(inNotes[inNotes.length - 1]?.key).toBe('delete');
  });

  it('Delete for me only (others\' message, or own past 30 min): Delete shows, last, no "30 min" hint', () => {
    const forMeOnly = messageMenuItems(itemProps({ canDelete: true, deleteForMeOnly: true }));
    const del = forMeOnly.find((i) => i.key === 'delete');
    expect(del?.label).toBe('Delete');
    expect(del?.hint).toBeUndefined();
    expect(del?.danger).toBe(true);
    expect(forMeOnly[forMeOnly.length - 1]?.key).toBe('delete');
    // An own message inside the window keeps its hint.
    const own = messageMenuItems(itemProps({ canDelete: true, deleteForMeOnly: false }));
    expect(own.find((i) => i.key === 'delete')?.hint).toBe('30 min');
  });

  it('one divider, before the first danger row, only when a danger row shows', () => {
    const both = messageMenuItems(itemProps({ canRemoveFile: true, canDelete: true }));
    expect(dividerBefore(both)).toBe(both.findIndex((i) => i.key === 'remove-file'));
    const deleteOnly = messageMenuItems(itemProps({ canDelete: true }));
    expect(dividerBefore(deleteOnly)).toBe(deleteOnly.length - 1);
    expect(dividerBefore(messageMenuItems(itemProps()))).toBeNull();
    // A danger row alone (nothing above it) needs no divider.
    const alone: MessageMenuItem = {
      kind: 'action',
      key: 'delete',
      label: 'Delete',
      icon: null,
      run: () => {},
      danger: true,
    };
    expect(dividerBefore([alone])).toBeNull();
  });

  it('runs the forward, edit, remove file and delete handlers', () => {
    const onForward = vi.fn();
    const onEdit = vi.fn();
    const onRemoveFile = vi.fn();
    const onDelete = vi.fn();
    const items = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canForward: true,
      onForward,
      canEdit: true,
      onEdit,
      canRemoveFile: true,
      onRemoveFile,
      canDelete: true,
      onDelete,
    });
    for (const key of ['forward', 'edit', 'remove-file', 'delete']) {
      items.find((i) => i.key === key)?.run();
    }
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('QUICK_REACTIONS', () => {
  it('is exactly the approved quick-react set, in order, followed by the "+"', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '✅', '❤️', '😂', '🙏']);
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
    const onDevice = ownMessageActions(msg({ createdAt: created }), deviceNow);
    const onServer = ownMessageActions(msg({ createdAt: created }), deviceNow + offset);
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
    let rows = ownMessageActions(message, serverNow());
    const recomputed: string[] = [];
    let cancel = (): void => {};
    const arm = (): void => {
      cancel = scheduleWindowBoundary({
        createdAt: message.createdAt,
        now: serverNow,
        onBoundary: () => {
          rows = ownMessageActions(message, serverNow());
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

describe('Transcribe', () => {
  it('sits after Select (none here) and before Forward for a voice note (no Copy row)', () => {
    const voice = {
      canCopy: false,
      canSelectText: false,
      canTranscribe: true,
      onTranscribe: () => {},
    };
    expect(menu(voice)).toEqual(['Reply', 'Transcribe', 'Forward']);
  });

  it('hides Transcribe when not offered (loading, or a transcript exists)', () => {
    expect(menu({ canCopy: false, canTranscribe: false })).not.toContain('Transcribe');
    expect(menu({ canCopy: false })).not.toContain('Transcribe');
  });

  it('runs onTranscribe', () => {
    const onTranscribe = vi.fn();
    const item = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canTranscribe: true,
      onTranscribe,
    }).find((i) => i.key === 'transcribe');
    item?.run();
    expect(onTranscribe).toHaveBeenCalledOnce();
  });
});

describe('the divider is the 1px border token', () => {
  it('a hairline above the danger rows, no new colour', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./MessageActionMenu.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('data-menu-divider="" className="border-t border-border"');
    expect(src.split('data-menu-divider').length - 1).toBe(1);
  });
});

describe('emoji picker dismiss (no-cross)', () => {
  it('closes with the ghost "Clear" text Button, never an X; remove-file keeps the bin', () => {
    const src = readFileSync(new URL('./MessageActionMenu.tsx', import.meta.url), 'utf8');
    const at = src.indexOf('aria-label="Close emoji picker"');
    expect(at).toBeGreaterThan(-1);
    const open = src.lastIndexOf('<Button', at);
    const end = src.indexOf('</Button>', at);
    expect(src.slice(open, end)).toContain('variant="ghost"');
    expect(src.slice(open, end)).toContain('Clear');
    expect(src).not.toMatch(/\bIconX\b/);
  });
});
