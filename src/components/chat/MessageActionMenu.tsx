import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  IconAlarmClock,
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconForward,
  IconNotePage,
  IconPlus,
  IconReply,
  IconSelectText,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MARK_TONE } from '@/components/chat/MarkBits';
import { useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
import { useBellOptional } from '@/components/chat/BellContext';
import { logger } from '@/lib/logger';
import { DELETE_SELECTION_WINDOW_MS } from '@/lib/chat/forward';
import { TYPE_LABEL, type ChatMark, type MarkType } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';
import { formatClock, formatSendLabel } from '@/lib/chat/scheduled';
import { cn } from '@/lib/cn';
import { STAR_LABEL, UNSTAR_LABEL } from '@/lib/chat/stars';

/** Quick-react row offered when a message's action menu is opened; "+" opens the picker after it. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🆗', '🙏'] as const;

/** The "+" after the quick reactions: opens the full emoji picker. */
export const MORE_REACTIONS_LABEL = 'More reactions';

/** An own message can be edited this long after its server created_at. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/** An own message can be deleted for everyone this long after its server created_at. */
export const DELETE_WINDOW_MS = DELETE_SELECTION_WINDOW_MS;

/**
 * Milliseconds from `nowMs` (server time) to the next window boundary of a
 * message (15 min: Edit goes, 30 min: Delete goes), or null when both have
 * passed or the message has no server time yet. Pure.
 */
export function nextWindowBoundaryMs(createdAt: string, nowMs: number): number | null {
  if (createdAt === '') return null;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  for (const window of [EDIT_WINDOW_MS, DELETE_WINDOW_MS]) {
    // The rows allow age <= window, so they change just after the boundary.
    const at = created + window + 1;
    if (at > nowMs) return at - nowMs;
  }
  return null;
}

/**
 * While a menu is open: one timeout for the message's next window boundary,
 * which calls `onBoundary` (the menu re-computes its rows, and the caller
 * schedules again from the new moment). No interval. Returns the cancel,
 * which the caller runs on close.
 */
export function scheduleWindowBoundary(input: {
  createdAt: string;
  /** Server time now (device clock plus the store's offset). */
  now: () => number;
  onBoundary: () => void;
}): () => void {
  const delay = nextWindowBoundaryMs(input.createdAt, input.now());
  if (delay === null) return () => {};
  const handle = setTimeout(input.onBoundary, delay);
  return () => clearTimeout(handle);
}

/** The one disabled line an own marked message shows in place of Edit and Delete. */
export const MARKED_LOCKED_LABEL = "Marked messages can't be edited or deleted";

/** The own-message rows a message offers when its menu opens. */
export interface OwnMessageActions {
  canEdit: boolean;
  canDelete: boolean;
  /** Own, recorded and marked: the single disabled "can't be edited or deleted" line. */
  lockedByMark: boolean;
}

/**
 * Edit and Delete for one message at `nowMs` (the moment the menu opens). Only
 * the caller's own recorded, live, unmarked message qualifies; the windows run
 * from the server created_at (a pending message has none, so neither row
 * shows). Edit also needs a body: attachments, cards and mentions are never
 * editable. Mirrors chat_message_edit / chat_message_delete. Pure.
 */
export function ownMessageActions(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'createdAt' | 'body' | 'deleted'>,
  mark: ChatMark | undefined,
  nowMs: number,
  /** Notes: Delete has no window (Edit keeps its 15 minutes). */
  notes = false,
): OwnMessageActions {
  const none = { canEdit: false, canDelete: false, lockedByMark: false };
  if (!message.mine || message.state !== 'sent' || message.deleted === true) return none;
  if (mark !== undefined) return { ...none, lockedByMark: true };
  if (message.createdAt === '') return none;
  const created = Date.parse(message.createdAt);
  if (Number.isNaN(created)) return none;
  const age = nowMs - created;
  return {
    canEdit: message.body.trim() !== '' && age <= EDIT_WINDOW_MS,
    canDelete: notes || age <= DELETE_WINDOW_MS,
    lockedByMark: false,
  };
}

/**
 * A plan card message (chat_plan_share): its menu hides Forward, Save to notes
 * and Edit; Reply, Copy (the plan's title), Mark as and Delete stay. Pure.
 */
export function isPlanMessage(message: Pick<ThreadMessage, 'sharedPlanIds'>): boolean {
  return (message.sharedPlanIds ?? []).length > 0;
}

/**
 * Whether a selection can be forwarded: never when it holds a plan card (a
 * plan is shared with chat_plan_share, not forwarded as a message). Pure.
 */
export function selectionForwardable(
  selected: ReadonlySet<string>,
  messages: ReadonlyArray<Pick<ThreadMessage, 'id' | 'sharedPlanIds'>>,
): boolean {
  return !messages.some((m) => selected.has(m.id) && isPlanMessage(m));
}

interface MessageActionMenuProps {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
  /**
   * The pressed bubble: a copy of it is drawn above the dimmed thread, in its
   * own colours, at its on-screen rect.
   */
  held?: HTMLElement | null;
  mine: boolean;
  currentReaction: string | null;
  /** Offers the reaction row (a recorded message); false hides it. */
  canReact?: boolean;
  /**
   * The laptop smiley beside a bubble: only the reactions row, no action rows.
   * Escape, the backdrop, scroll and resize close it like the full menu.
   */
  reactionsOnly?: boolean;
  canCopy: boolean;
  /**
   * Offers "Transcribe" (a voice note with no transcript on this device, or
   * whose last attempt failed; never while one is in flight).
   */
  canTranscribe?: boolean;
  onTranscribe?: () => void;
  /**
   * Offers "Star" (or "Unstar" when `starred`), after Copy or Transcribe: any
   * recorded, live message, own or not, in every chat.
   */
  canStar?: boolean;
  /** The message is starred: the row reads "Unstar". */
  starred?: boolean;
  onStar?: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  /** Types the "Mark as" submenu offers; empty hides the row. */
  markOptions?: readonly MarkType[];
  onMark?: (type: MarkType) => void;
  /** The message's mark type when it carries one: "Marked as <type>", not interactive. */
  markedAs?: MarkType | null;
  /** Offers "Forward" (a recorded message, anyone's). */
  canForward?: boolean;
  onForward?: () => void;
  /** Offers "Edit" (see ownMessageActions). */
  canEdit?: boolean;
  onEdit?: () => void;
  /** Offers "Delete" (see ownMessageActions). */
  canDelete?: boolean;
  onDelete?: () => void;
  /** Own marked message: the single disabled line in place of Edit and Delete. */
  lockedByMark?: boolean;
  /**
   * Offers "Save to notes", between Copy and Remind me (a recorded, live
   * message in any chat but notes).
   */
  canSaveToNotes?: boolean;
  onSaveToNotes?: () => void;
  /** The menu is in Personal notes: Delete carries no "30 min" hint. */
  notes?: boolean;
  /**
   * Offers "Select": select part of this message's body text in place (a
   * recorded, live message with a typed body, never a voice note alone).
   */
  canSelectText?: boolean;
  onSelectText?: () => void;
  /**
   * Offers "Remind me" (a recorded message). When absent, the menu offers it
   * itself for the held bubble's message inside a BellProvider.
   */
  canRemind?: boolean;
  onRemind?: () => void;
  /**
   * The viewer's pending reminder on this message (its remind_at): the same
   * slot then reads "Reminder · <time>" and opens the sheet to change or
   * cancel it. Never shown on the bubble itself.
   */
  reminderAt?: string | null;
}

/** One entry of the message action menu. */
export type MessageMenuItem =
  | {
      kind: 'action';
      key: string;
      label: string;
      icon: ReactNode;
      run: () => void;
      /** Text in the bad token (Delete). */
      danger?: boolean;
      /** Muted note at the right ("15 min"). */
      hint?: string;
      /** Opens the in-place submenu instead of running and closing. */
      submenu?: boolean;
      /** A colour dot in place of the icon (the mark types). */
      dot?: MarkType;
      /** A time after the label, in mono ("Reminder · 9:00 AM"). */
      mono?: string;
    }
  | { kind: 'note'; key: string; label: string; icon: ReactNode };

type MenuItemProps = Pick<
  MessageActionMenuProps,
  | 'canCopy'
  | 'onReply'
  | 'onCopy'
  | 'canTranscribe'
  | 'onTranscribe'
  | 'canStar'
  | 'starred'
  | 'onStar'
  | 'markOptions'
  | 'onMark'
  | 'markedAs'
  | 'canForward'
  | 'onForward'
  | 'canEdit'
  | 'onEdit'
  | 'canDelete'
  | 'onDelete'
  | 'lockedByMark'
  | 'canSaveToNotes'
  | 'onSaveToNotes'
  | 'notes'
  | 'canSelectText'
  | 'onSelectText'
  | 'canRemind'
  | 'onRemind'
  | 'reminderAt'
>;

/** The ban glyph (circle with a slash) for tombstones and the locked line. */
export function BanGlyph(props: { size?: number }): ReactElement {
  const size = props.size ?? 18;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

/** The menu row that copies a message into Personal notes. */
export const SAVE_TO_NOTES_LABEL = 'Save to notes';

/** The Transcribe row's glyph: three text lines, drawn like the icon set (stroke 1.7). */
export function TranscribeGlyph(props: { size?: number }): ReactElement {
  const size = props.size ?? 18;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  );
}

/**
 * A row's tap, inside its click: the action runs before the menu closes, so
 * Reply focuses the composer within the user's own tap (decision 128) and the
 * menu's focus return finds focus already taken. Mark opens its submenu; Back
 * returns from it; neither closes. Pure.
 */
export function runMenuItem(
  item: MessageMenuItem,
  menu: { openMark: () => void; close: () => void },
): void {
  if (item.kind !== 'action') return;
  if (item.key === 'mark') {
    menu.openMark();
    return;
  }
  if (item.key === 'back') {
    item.run();
    return;
  }
  item.run();
  menu.close();
}

/** The menu's glyph size (the row icons, 22px at stroke 1.7). */
export const MENU_ICON_SIZE = 22;

/** The row that selects part of one message's text in place. */
export const SELECT_TEXT_LABEL = 'Select';

/**
 * The main view in display order: Reply, Forward, Copy, Transcribe, Select,
 * Star (or Unstar), "Save to notes", "Remind me" (or "Reminder · <time>"),
 * "Mark as" (or the static "Marked as <type>"), Edit, Delete (or the locked
 * line). No dividers. Rows that do not apply are not rendered. Pure (no hooks)
 * so the row set is unit-tested without a DOM.
 */
export function messageMenuItems(props: MenuItemProps): MessageMenuItem[] {
  const size = MENU_ICON_SIZE;
  const items: MessageMenuItem[] = [
    {
      kind: 'action',
      key: 'reply',
      label: 'Reply',
      icon: <IconReply size={size} />,
      run: props.onReply,
    },
  ];
  if (props.canForward === true) {
    items.push({
      kind: 'action',
      key: 'forward',
      label: 'Forward',
      icon: <IconForward size={size} />,
      run: () => props.onForward?.(),
    });
  }
  if (props.canCopy) {
    items.push({
      kind: 'action',
      key: 'copy',
      label: 'Copy',
      icon: <IconCopy size={size} />,
      run: props.onCopy,
    });
  }
  if (props.canTranscribe === true) {
    items.push({
      kind: 'action',
      key: 'transcribe',
      label: 'Transcribe',
      icon: <TranscribeGlyph size={size} />,
      run: () => props.onTranscribe?.(),
    });
  }
  if (props.canSelectText === true) {
    items.push({
      kind: 'action',
      key: 'select-text',
      label: SELECT_TEXT_LABEL,
      icon: <IconSelectText size={size} />,
      run: () => props.onSelectText?.(),
    });
  }
  if (props.canStar === true) {
    const starred = props.starred === true;
    items.push({
      kind: 'action',
      key: 'star',
      label: starred ? UNSTAR_LABEL : STAR_LABEL,
      icon: starred ? <IconStarFilled size={size} /> : <IconStar size={size} />,
      run: () => props.onStar?.(),
    });
  }
  if (props.canSaveToNotes === true) {
    items.push({
      kind: 'action',
      key: 'save-notes',
      label: SAVE_TO_NOTES_LABEL,
      icon: <IconNotePage size={size} />,
      run: () => props.onSaveToNotes?.(),
    });
  }
  if (props.canRemind === true) {
    const at = props.reminderAt != null ? new Date(props.reminderAt) : null;
    items.push({
      kind: 'action',
      key: 'remind',
      label: at !== null && !Number.isNaN(at.getTime()) ? REMINDER_SET_LABEL : 'Remind me',
      icon: <IconAlarmClock size={size} />,
      run: () => props.onRemind?.(),
      ...(at !== null && !Number.isNaN(at.getTime())
        ? { mono: reminderMenuTime(at, new Date()) }
        : {}),
    });
  }
  if (props.markedAs != null) {
    items.push({
      kind: 'note',
      key: 'marked',
      label: `Marked as ${TYPE_LABEL[props.markedAs]}`,
      icon: <IconBookmark size={size} />,
    });
  } else if ((props.markOptions ?? []).length > 0) {
    items.push({
      kind: 'action',
      key: 'mark',
      label: 'Mark as',
      icon: <IconBookmark size={size} />,
      run: () => {},
      submenu: true,
    });
  }
  if (props.lockedByMark === true) {
    items.push({
      kind: 'note',
      key: 'locked',
      label: MARKED_LOCKED_LABEL,
      icon: <BanGlyph size={size} />,
    });
  } else {
    if (props.canEdit === true) {
      items.push({
        kind: 'action',
        key: 'edit',
        label: 'Edit',
        icon: <IconEdit size={size} />,
        hint: '15 min',
        run: () => props.onEdit?.(),
      });
    }
    if (props.canDelete === true) {
      items.push({
        kind: 'action',
        key: 'delete',
        label: 'Delete',
        icon: <IconTrash size={size} />,
        ...(props.notes === true ? {} : { hint: '30 min' }),
        danger: true,
        run: () => props.onDelete?.(),
      });
    }
  }
  return items;
}

/** The "Mark as" submenu: Back, then each offered type with its colour dot. */
export function markSubmenuItems(
  props: Pick<MessageActionMenuProps, 'markOptions' | 'onMark'>,
  onBack: () => void,
): MessageMenuItem[] {
  return [
    {
      kind: 'action',
      key: 'back',
      label: 'Back',
      icon: <IconChevronLeft size={MENU_ICON_SIZE} />,
      run: onBack,
      submenu: true,
    },
    ...(props.markOptions ?? []).map(
      (type): MessageMenuItem => ({
        kind: 'action',
        key: `mark-${type}`,
        label: TYPE_LABEL[type],
        icon: null,
        dot: type,
        run: () => props.onMark?.(type),
      }),
    ),
  ];
}

/** The dot colour per mark type (the badge's tone). */
const DOT_CLASS: Record<string, string> = {
  good: 'bg-good',
  accent: 'bg-accent',
  warn: 'bg-warn',
};

/** Whether a keydown while the menu is open closes it. */
export function menuClosesOnKey(key: string): boolean {
  return key === 'Escape';
}

/** Anything that can find the menu's first action row (the menu container). */
interface MenuRoot {
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null;
}

/**
 * Move focus to the first action row (Reply) so keyboard users land in the
 * menu; Tab then walks the rows in display order. preventScroll keeps the
 * menu's own scroll-to-close listener from firing.
 */
export function focusFirstMenuItem(root: MenuRoot | null): boolean {
  const first = root?.querySelector('[data-menu-item]') ?? null;
  if (first === null) return false;
  first.focus({ preventScroll: true });
  return true;
}

/** A row's box: full-bleed, at least 44px, 16px side padding, 14px to the label. */
export const MENU_ROW = 'flex min-h-[44px] w-full items-center gap-[14px] px-4';

/** One row of the menu box: 16px text, the 22px icon (or dot) left in the row's ink, a muted hint or chevron right. */
export function MenuRow(props: {
  item: MessageMenuItem;
  onRun: (item: MessageMenuItem) => void;
}): ReactElement {
  const item = props.item;
  if (item.kind === 'note') {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        data-menu-note={item.key}
        className={cn(MENU_ROW, 'text-[15px] text-fg-3')}
      >
        <span className="flex w-[22px] shrink-0 justify-center">{item.icon}</span>
        <span className="min-w-0">{item.label}</span>
      </div>
    );
  }
  const icon =
    item.dot !== undefined ? (
      <span
        aria-hidden="true"
        className={cn('h-2.5 w-2.5 rounded-full', DOT_CLASS[MARK_TONE[item.dot]])}
      />
    ) : (
      item.icon
    );
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item={item.key}
      onClick={() => props.onRun(item)}
      className={cn(
        MENU_ROW,
        'text-left text-[16px] transition-colors',
        'hover:bg-panel-2 focus:outline-none focus-visible:bg-panel-2',
        item.danger === true ? 'text-bad' : 'text-fg',
      )}
    >
      <span data-menu-icon="" className="flex w-[22px] shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {item.label}
        {item.mono !== undefined ? (
          <span data-menu-mono="" className="font-mono text-[13px] tabular-nums">
            {item.mono}
          </span>
        ) : null}
      </span>
      {item.hint !== undefined ? (
        <span className="shrink-0 text-[13px] text-fg-3">{item.hint}</span>
      ) : null}
      {item.submenu === true && item.key !== 'back' ? (
        <span className="shrink-0 text-fg-3">
          <IconChevronRight />
        </span>
      ) : null}
    </button>
  );
}

interface Coords {
  top: number;
  left: number;
}

/**
 * The menu panel's width. Six 44x44 reaction cells (the touch-target floor),
 * the row's 10px sides and the 1px border each side need 286px, so the panel
 * is that wide, never less.
 */
export const MENU_WIDTH_PX = 286;

/** What computeMenuPlacement decides; see there. */
export interface MenuPlacement {
  /** How far the held bubble's copy moves on Y (0 or negative: up only). */
  bubbleShiftY: number;
  /** The menu's top edge (viewport px): always below the held copy. */
  menuTop: number;
  /** The held copy's visible height when it is too tall to fit above the menu. */
  clipBubbleHeight: number | undefined;
}

/**
 * WhatsApp-style placement: the menu always opens below the held bubble,
 * `gap` under it. When there is no room below, the bubble's copy moves up by
 * the shortfall (never so far that its top passes safeTop + margin). A copy
 * still too tall is clipped to the room left (its top stays visible) and the
 * menu sits right under the clipped copy. Never above the bubble. Pure.
 */
export function computeMenuPlacement(input: {
  bubbleRect: { top: number; bottom: number };
  menuHeight: number;
  /** The visible viewport's height (visualViewport when present: the keyboard is out). */
  viewportHeight: number;
  safeTop: number;
  safeBottom: number;
  gap: number;
  margin: number;
}): MenuPlacement {
  const { bubbleRect, menuHeight, gap, margin } = input;
  const bubbleHeight = Math.max(0, bubbleRect.bottom - bubbleRect.top);
  const floor = input.viewportHeight - input.safeBottom - margin;
  const ceiling = input.safeTop + margin;
  const shortfall = bubbleRect.bottom + gap + menuHeight - floor;
  if (shortfall <= 0) {
    return { bubbleShiftY: 0, menuTop: bubbleRect.bottom + gap, clipBubbleHeight: undefined };
  }
  // Up by the shortfall, but the copy's top never above the ceiling (and never down).
  const bubbleShiftY = Math.min(0, Math.max(-shortfall, ceiling - bubbleRect.top));
  const top = bubbleRect.top + bubbleShiftY;
  const room = Math.max(0, floor - menuHeight - gap - top);
  if (bubbleHeight <= room) {
    return { bubbleShiftY, menuTop: top + bubbleHeight + gap, clipBubbleHeight: undefined };
  }
  return { bubbleShiftY, menuTop: top + room + gap, clipBubbleHeight: room };
}

/** The visible viewport's bottom in layout px: visualViewport (the iOS keyboard) when present. */
export function visibleViewportHeight(win: {
  innerHeight: number;
  visualViewport?: { height: number; offsetTop: number } | null;
}): number {
  const vv = win.visualViewport;
  return vv != null ? vv.offsetTop + vv.height : win.innerHeight;
}

/** The held copy's transform: translateY only, never X, scale or rotate. */
export function heldTransform(shiftY: number): string {
  return `translateY(${shiftY}px)`;
}

/**
 * The reactions row: the five quick reactions, then a "+" that opens the full
 * picker. Six 44x44 controls. Hook-free so the tests call it directly.
 */
export function ReactionsRow(props: {
  currentReaction: string | null;
  /** The laptop smiley's row alone: its buttons are the menu's focus stops. */
  reactionsOnly: boolean;
  onReact: (emoji: string) => void;
  onMore: () => void;
  /** The "+": the picker hands focus back to it on close. */
  moreRef?: RefObject<HTMLButtonElement>;
}): ReactElement {
  const { currentReaction, reactionsOnly } = props;
  return (
    <div
      data-menu-reactions=""
      // 8px 10px around six 44x44 cells; one hairline under it (the menu's only divider).
      className={cn(
        'flex items-center justify-between px-[10px] py-2',
        !reactionsOnly && 'border-b border-border',
      )}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React ${emoji}`}
          aria-pressed={emoji === currentReaction}
          {...(reactionsOnly ? { 'data-menu-item': `react-${emoji}` } : {})}
          onClick={() => props.onReact(emoji)}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl hover:bg-panel-2',
            emoji === currentReaction && 'bg-panel-3',
          )}
        >
          <span aria-hidden="true">{emoji}</span>
        </button>
      ))}
      <button
        ref={props.moreRef}
        type="button"
        data-react-more=""
        aria-label={MORE_REACTIONS_LABEL}
        aria-haspopup="dialog"
        {...(reactionsOnly ? { 'data-menu-item': 'react-more' } : {})}
        onClick={props.onMore}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panel-2 text-fg-2 hover:bg-panel-3 hover:text-fg"
      >
        <IconPlus size={20} />
      </button>
    </div>
  );
}

/**
 * A pick from the full picker: react through the same path as the quick row,
 * once, then close the picker and the menu.
 */
export function pickReaction(
  emoji: string,
  handlers: { onReact: (emoji: string) => void; closePicker: () => void; closeMenu: () => void },
): void {
  handlers.onReact(emoji);
  handlers.closePicker();
  handlers.closeMenu();
}

/** Whether a scroll event came from inside the emoji picker (its grid scrolls; the menu stays). */
export function scrollFromPicker(target: EventTarget | null): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    target.closest('[data-emoji-picker]') !== null
  );
}

/**
 * Whether a window scroll or resize closes the menu. Never while the picker is
 * open: the keyboard opening (resize) and iOS scrolling a fixed input into
 * view (scroll) must not take the picker down with the menu. Otherwise any
 * resize, and any scroll outside the picker, closes it.
 */
export function menuClosesOnViewport(
  kind: 'scroll' | 'resize',
  state: { picking: boolean; target: EventTarget | null },
): boolean {
  if (state.picking) return false;
  return kind === 'resize' || !scrollFromPicker(state.target);
}

/** The picker body's chunk (EmojiPicker.tsx plus the emoji data), loaded on demand. */
export type EmojiPickerModule = typeof import('@/components/chat/EmojiPicker');

let emojiPickerModule: EmojiPickerModule | null = null;
let emojiPickerLoad: Promise<EmojiPickerModule> | null = null;

/**
 * Start (once) loading the picker chunk; the menu calls it as it opens so "+"
 * opens with the grid ready. A failed load is forgotten so the next open
 * tries again.
 */
export function loadEmojiPicker(
  importer: () => Promise<EmojiPickerModule> = () => import('@/components/chat/EmojiPicker'),
): Promise<EmojiPickerModule> {
  emojiPickerLoad ??= importer().then(
    (module) => {
      emojiPickerModule = module;
      return module;
    },
    (error: unknown) => {
      emojiPickerLoad = null;
      throw error;
    },
  );
  return emojiPickerLoad;
}

/** The picker chunk when it has already arrived, else null. */
export function loadedEmojiPicker(): EmojiPickerModule | null {
  return emojiPickerModule;
}

/** Test seam: forget the loaded chunk. */
export function resetEmojiPickerLoad(): void {
  emojiPickerModule = null;
  emojiPickerLoad = null;
}

/** The laptop popover's size (the touch sheet is 70vh). */
export const EMOJI_POPOVER_WIDTH = 352;
export const EMOJI_POPOVER_HEIGHT = 400;

/**
 * Where the laptop popover sits: above the anchor (the action menu) when there
 * is room, else below it, else pinned inside the viewport; aligned to the
 * anchor's left edge and kept 8px inside. Pure.
 */
export function popoverPosition(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left'>,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const above = anchor.top - EMOJI_POPOVER_HEIGHT - 8;
  const below = anchor.bottom + 8;
  const top =
    above >= 8
      ? above
      : below + EMOJI_POPOVER_HEIGHT <= viewport.height - 8
        ? below
        : Math.max(8, viewport.height - EMOJI_POPOVER_HEIGHT - 8);
  const left = Math.max(8, Math.min(anchor.left, viewport.width - EMOJI_POPOVER_WIDTH - 8));
  return { top, left };
}

/** Anything focusable the picker's focus rules touch (an element, or a test fake). */
export interface Focusable {
  focus: (options?: FocusOptions) => void;
}

/** The picker dialog as its focus rules read it. */
export interface PickerRoot extends Focusable {
  querySelector: (selectors: string) => Focusable | null;
}

/**
 * Where focus lands when the picker opens: the search field on a laptop (once
 * the body has arrived), the sheet container on touch, never its search field,
 * so no keyboard pops up. Pure but for the lookup.
 */
export function pickerInitialFocus(layout: ChatLayout, root: PickerRoot): Focusable {
  if (layout === 'laptop') return root.querySelector('[data-emoji-search]') ?? root;
  return root;
}

/**
 * The focus trap's Tab: the next (or previous) focusable inside the picker,
 * wrapping at either end; from outside the list (the container), the first or
 * last. Null when nothing inside can take focus. Pure.
 */
export function nextTrapFocus<T>(
  focusables: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const at = active === null ? -1 : focusables.indexOf(active);
  if (at === -1) return (backwards ? focusables[focusables.length - 1] : focusables[0]) ?? null;
  const next = (at + (backwards ? -1 : 1) + focusables.length) % focusables.length;
  return focusables[next] ?? null;
}

/** Hand focus back to "+" when the picker closes (skipped when "+" left with the menu). */
export function returnPickerFocus(plus: (Focusable & { isConnected: boolean }) | null): boolean {
  if (plus === null || !plus.isConnected) return false;
  plus.focus({ preventScroll: true });
  return true;
}

const PICKER_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The picker body's load failure line (never the raw error). */
export const EMOJI_LOAD_FAILED = "Couldn't load emoji";

/** What the picker shell shows under its frame. Pure. */
export function pickerBodyState(
  module: EmojiPickerModule | null,
  failed: boolean,
): 'ready' | 'failed' | 'loading' {
  if (module !== null) return 'ready';
  return failed ? 'failed' : 'loading';
}

/** The grid area when the picker chunk failed to load: the line and a 44x44 Try again. */
export function EmojiPickerLoadFailed(props: { onRetry: () => void }): ReactElement {
  return (
    <div
      data-emoji-failed=""
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <p className="text-sm text-fg-3">{EMOJI_LOAD_FAILED}</p>
      <Button
        type="button"
        size="lg"
        data-emoji-retry=""
        className="min-w-[44px]"
        onClick={props.onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

/**
 * The emoji picker's shell. Touch: a bottom sheet over a dim, translateY
 * only, the safe-area inset kept clear. Laptop: a modal popover anchored to
 * `anchor`, opacity only. Both are drawn at their final size at once; the body
 * (EmojiPicker.tsx, a separate chunk) fills in when it arrives, so a "+" that
 * beats the chunk never jumps. Focus is trapped inside, lands on the search
 * field (laptop) or the sheet (touch), and returns to "+" on close. It closes
 * only on a pick (the caller), Escape, a tap on the dim or its close control.
 */
export function EmojiPickerShell(props: {
  open: boolean;
  onClose: () => void;
  onPick: (char: string) => void;
  layout: ChatLayout;
  /** The laptop popover's anchor (the menu's rect); ignored on touch. */
  anchor: DOMRect | null;
  /** The "+" that opened it: focus goes back there on close. */
  returnFocus: RefObject<HTMLElement>;
}): ReactElement | null {
  const { open, onClose, layout, returnFocus } = props;
  const [module, setModule] = useState<EmojiPickerModule | null>(loadedEmojiPicker);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const ready = module !== null;

  // The chunk normally arrived while the menu was open; if not, wait for it
  // here. A failure shows the retry line; Try again runs the import again.
  useEffect(() => {
    if (!open || module !== null) return;
    let cancelled = false;
    setFailed(false);
    loadEmojiPicker().then(
      (loaded) => {
        if (!cancelled) setModule(loaded);
      },
      (error: unknown) => {
        logger.warn('chat: emoji picker load failed', { error: String(error) });
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, module, attempt]);
  const retryLoad = (): void => setAttempt((n) => n + 1);

  // Entrance: flip after mount so the one transition runs.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  // Initial focus, and back to "+" on close.
  useEffect(() => {
    if (!open) return;
    const plus = returnFocus.current;
    return () => {
      returnPickerFocus(plus);
    };
  }, [open, returnFocus]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) return;
    // Laptop: once the body arrives the search field takes focus from the shell.
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      active !== dialog &&
      dialog.contains(active)
    ) {
      return;
    }
    pickerInitialFocus(layout, dialog).focus({ preventScroll: true });
  }, [open, ready, failed, layout]);

  if (!open) return null;

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    event.preventDefault();
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(PICKER_FOCUSABLE));
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nextTrapFocus(focusables, active, event.shiftKey)?.focus();
  };

  const close = (
    <IconButton
      label="Close emoji picker"
      data-emoji-close=""
      className="shrink-0"
      onClick={onClose}
    >
      <IconX size={18} />
    </IconButton>
  );
  const body =
    module !== null ? (
      <module.EmojiPickerPanel onPick={props.onPick} layout={layout} trailing={close} />
    ) : (
      // The body's own rows at their own heights, empty until the chunk lands.
      <>
        <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
          <div
            aria-hidden="true"
            className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-panel-2"
          />
          {close}
        </div>
        <div aria-hidden="true" className="h-11 shrink-0 border-b border-border" />
        {failed ? (
          <EmojiPickerLoadFailed onRetry={retryLoad} />
        ) : (
          <div data-emoji-loading="" className="min-h-0 flex-1" />
        )}
      </>
    );
  const dialogProps = {
    ref: dialogRef,
    role: 'dialog',
    'aria-label': 'Emoji picker',
    'aria-modal': true,
    'aria-busy': pickerBodyState(module, failed) === 'loading',
    tabIndex: -1,
    onKeyDown: trapTab,
  } as const;

  if (layout === 'laptop') {
    const position =
      props.anchor !== null
        ? popoverPosition(props.anchor, { width: window.innerWidth, height: window.innerHeight })
        : null;
    return createPortal(
      <>
        <div data-emoji-dismiss="" className="fixed inset-0 z-[60]" onClick={onClose} />
        <div
          {...dialogProps}
          data-emoji-picker="laptop"
          className={cn(
            'fixed z-[60] flex h-[400px] w-[352px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl transition-opacity duration-fast focus:outline-none motion-reduce:transition-none',
            shown ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
          )}
          style={{ top: position?.top ?? 8, left: position?.left ?? 8 }}
        >
          {body}
        </div>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div data-emoji-dismiss="" className="fixed inset-0 z-[60] bg-black/45" onClick={onClose}>
      <div
        {...dialogProps}
        data-emoji-picker="touch"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'absolute inset-x-0 bottom-0 flex h-[70vh] flex-col overflow-hidden rounded-t-2xl border-t border-border-strong bg-panel pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-base focus:outline-none motion-reduce:transition-none',
          shown ? 'translate-y-0 ease-enter' : 'translate-y-full ease-exit',
        )}
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Floating, anchored action menu opened by long-press (touch), right-click, the
 * hover ⋯ control (pointer devices) or Enter / Space on a focused bubble. One
 * box: the quick reactions on top (hairline under them), then the action rows.
 * "Mark as" swaps the rows for its submenu in place (no slide). While open, a
 * 55% black backdrop dims the thread and a copy of the held bubble sits above
 * it in its own colours. It focuses the first row on open and hands focus back
 * on close. Renders into document.body via a portal (mirrors Sheet.tsx) so it
 * escapes the scrolling thread. Position is computed from the anchor rect in a
 * two-pass layout effect: measured while hidden, then always placed below the
 * bubble (computeMenuPlacement; the held copy moves up, translateY only, when
 * there is no room) and aligned to the bubble's side. Closes on backdrop
 * click, Escape, scroll, or resize (scroll and resize never while the emoji
 * picker is open). The menu's motion is opacity + scale only. All colours
 * are design tokens, so light and dark stay at parity.
 */
/** The reminder row's label when one is pending; the time follows in mono. */
export const REMINDER_SET_LABEL = 'Reminder · ';

/**
 * A pending reminder's time for the menu, device-local: "3:20 PM" today, else
 * "Tomorrow 9:00 AM" or "Wed 7 Oct, 11:30 AM". Pure.
 */
export function reminderMenuTime(at: Date, now: Date): string {
  const label = formatSendLabel(at, now);
  return label.startsWith('Today ') ? formatClock(at) : label;
}

type BellRemind = Pick<
  NonNullable<ReturnType<typeof useBellOptional>>,
  'canRemind' | 'openReminderFor'
> &
  Partial<Pick<NonNullable<ReturnType<typeof useBellOptional>>, 'pendingReminderFor'>>;

/**
 * "Remind me" for the menu: the caller's own wiring when given, else the
 * bell's for the held bubble's row (its data-msg-id). With a pending reminder
 * on that message (the bell's already-loaded list, no read here) the row
 * carries its time and opens the sheet in change mode. Pure but for the lookup.
 */
export function remindProps(
  props: Pick<MessageActionMenuProps, 'canRemind' | 'onRemind' | 'reminderAt'>,
  bell: BellRemind | null,
  held: HTMLElement | null | undefined,
): Pick<MessageActionMenuProps, 'canRemind' | 'onRemind' | 'reminderAt'> {
  if (props.canRemind !== undefined) return props;
  const messageId = held?.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null;
  if (bell === null || messageId === null || !bell.canRemind(messageId)) return {};
  const pending = bell.pendingReminderFor?.(messageId) ?? null;
  return {
    canRemind: true,
    onRemind: () => bell.openReminderFor(messageId),
    ...(pending !== null ? { reminderAt: pending.remind_at } : {}),
  };
}

/**
 * The menu panel (its own look; the shared popover panel stays as it is):
 * 18px radius, a 1px border-border hairline, no inner padding (rows are
 * full-bleed), clipped to the radius.
 */
export const MENU_PANEL =
  'overflow-hidden rounded-[18px] border border-border bg-panel shadow-2xl transition-[opacity,transform] duration-fast motion-reduce:transition-none';

/** The held copy's return on close, ms (the --dur-fast token). */
export const HELD_RETURN_MS = 120;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the viewer asked for reduced motion (read once per open). */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

/** A probe's padding in px (the safe-area insets, which JS cannot read directly). */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** The menu's placement and the held copy's shift, decided in the measuring pass. */
interface Placed extends Coords {
  shift: number;
  clip: number | undefined;
}

export function MessageActionMenu(props: MessageActionMenuProps): ReactElement | null {
  const { open, onClose, anchor, mine, currentReaction, onReact, held } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const heldRef = useRef<HTMLDivElement>(null);
  const safeRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Placed | null>(null);
  const [heldRect, setHeldRect] = useState<DOMRect | null>(null);
  const [shown, setShown] = useState(false);
  const [view, setView] = useState<'main' | 'mark'>('main');
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  const moreRef = useRef<HTMLButtonElement>(null);
  const layout = useChatLayout();
  const bell = useBellOptional();
  // The held copy glides back on close (translateY only) when it had moved;
  // Select, scroll, resize and reduced motion close at once.
  const [instantClose, setInstantClose] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReturning(false);
      setInstantClose(false);
    } else if (coords !== null && coords.shift !== 0 && !instantClose && !reduced) {
      setReturning(true);
    }
  }

  // The picker's chunk starts loading as the menu opens, so "+" opens it ready.
  useEffect(() => {
    if (!open || loadedEmojiPicker() !== null) return;
    loadEmojiPicker().catch((error: unknown) =>
      logger.warn('chat: emoji picker preload failed', { error: String(error) }),
    );
  }, [open]);

  useEffect(() => {
    if (open) return;
    setView('main');
    setPicking(false);
  }, [open]);

  // Measured while hidden, then placed below the held bubble (never above).
  useLayoutEffect(() => {
    if (!open || anchor === null) {
      if (!returning) setCoords(null);
      return;
    }
    const el = containerRef.current;
    if (el === null) return;
    setReduced(prefersReducedMotion());
    // Layout size, not the rect: the entrance scale (0.96) would shrink it.
    const rect = { width: el.offsetWidth, height: el.offsetHeight };
    const safe = safeRef.current !== null ? getComputedStyle(safeRef.current) : null;
    const placement = computeMenuPlacement({
      bubbleRect: anchor,
      menuHeight: rect.height,
      viewportHeight: visibleViewportHeight(window),
      safeTop: px(safe?.paddingTop ?? ''),
      safeBottom: px(safe?.paddingBottom ?? ''),
      gap: 8,
      margin: 8,
    });
    const rawLeft = mine ? anchor.right - rect.width : anchor.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - rect.width - 8));
    setCoords({
      top: placement.menuTop,
      left,
      shift: placement.bubbleShiftY,
      clip: placement.clipBubbleHeight,
    });
  }, [open, anchor, mine, view, returning]);

  // The held bubble: a static copy (no handlers, not focusable) at its rect.
  useLayoutEffect(() => {
    const slot = heldRef.current;
    if (!open && returning) return;
    if (!open || held == null || !held.isConnected) {
      setHeldRect(null);
      slot?.replaceChildren();
      return;
    }
    setHeldRect(held.getBoundingClientRect());
    if (slot === null) return;
    const copy = held.cloneNode(true) as HTMLElement;
    copy.removeAttribute('tabindex');
    copy.style.transform = '';
    copy.style.transition = '';
    slot.replaceChildren(copy);
  }, [open, held, returning]);

  // The return glide ends: drop the copy.
  useEffect(() => {
    if (!returning) return;
    const id = window.setTimeout(() => {
      setReturning(false);
      setCoords(null);
    }, HELD_RETURN_MS);
    return () => window.clearTimeout(id);
  }, [returning]);

  // Entrance motion: flip to the shown state after the menu mounts so the
  // opacity + scale transition runs (no translate, no rotate).
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Coords land after the measuring pass; focus the first row once placed.
  const placed = coords !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const previous = document.activeElement;
    focusFirstMenuItem(containerRef.current);
    return () => {
      // Only when nothing else took focus (Reply may focus the composer).
      const current = document.activeElement;
      const idle = current === null || current === document.body;
      if (idle && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, placed]);

  // The submenu swap moves focus to its first row (Back), and back again.
  useEffect(() => {
    if (!open || !placed) return;
    focusFirstMenuItem(containerRef.current);
  }, [open, placed, view]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (menuClosesOnKey(event.key)) onClose();
    }
    // While the picker is open the menu ignores scroll and resize (the
    // keyboard opening, iOS scrolling its input into view); otherwise a scroll
    // outside the picker or any resize closes it, at once (no glide back).
    function onScroll(event: Event): void {
      if (menuClosesOnViewport('scroll', { picking: pickingRef.current, target: event.target })) {
        setInstantClose(true);
        onClose();
      }
    }
    function onResize(): void {
      if (menuClosesOnViewport('resize', { picking: pickingRef.current, target: null })) {
        setInstantClose(true);
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, onClose]);

  const active = open && anchor !== null;
  if (!active && !returning) return null;

  const reactionsOnly = props.reactionsOnly === true;
  const items = !active
    ? []
    : reactionsOnly
      ? []
      : view === 'mark'
        ? markSubmenuItems(props, () => setView('main'))
        : messageMenuItems({ ...props, ...remindProps(props, bell, held) });
  const run = (item: MessageMenuItem): void => {
    // Select hands the bubble to the native selection: no glide back.
    if (item.key === 'select-text') setInstantClose(true);
    runMenuItem(item, { openMark: () => setView('mark'), close: onClose });
  };
  // The copy's Y: the shift once shown (at once under reduced motion), home on the way out.
  const shift = coords?.shift ?? 0;
  const heldY = returning ? 0 : shown || reduced ? shift : 0;
  const clip = coords?.clip;

  return createPortal(
    <>
      <div
        data-menu-backdrop=""
        className={cn(
          'fixed inset-0 z-40 bg-black/55 transition-opacity duration-fast motion-reduce:transition-none',
          shown && !returning ? 'opacity-100' : 'opacity-0',
          returning && 'pointer-events-none',
        )}
        onClick={onClose}
      />
      <div
        ref={safeRef}
        aria-hidden="true"
        data-menu-safe=""
        className="pointer-events-none invisible fixed left-0 top-0 h-0 w-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      />
      <div
        ref={heldRef}
        aria-hidden="true"
        data-menu-held=""
        data-shift={shift}
        className={cn(
          'pointer-events-none fixed z-40 flex transition-transform duration-fast motion-reduce:transition-none',
          returning ? 'ease-exit' : 'ease-enter',
          clip !== undefined && 'overflow-hidden',
        )}
        style={
          heldRect !== null
            ? {
                top: heldRect.top,
                left: heldRect.left,
                width: heldRect.width,
                transform: heldTransform(heldY),
                ...(clip !== undefined ? { height: clip } : {}),
              }
            : { visibility: 'hidden' }
        }
      />
      {active ? (
        <div
          ref={containerRef}
          role="menu"
          aria-label="Message actions"
          data-menu-items=""
          className={cn(
            'fixed z-50 max-w-[calc(100vw-16px)]',
            MENU_PANEL,
            mine ? 'origin-top-right' : 'origin-top-left',
            shown ? 'scale-100 opacity-100 ease-enter' : 'scale-[0.96] opacity-0 ease-exit',
          )}
          style={{
            width: MENU_WIDTH_PX,
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            visibility: coords === null ? 'hidden' : 'visible',
          }}
        >
          {props.canReact !== false && view === 'main' ? (
            <ReactionsRow
              currentReaction={currentReaction}
              reactionsOnly={reactionsOnly}
              onReact={(emoji) => {
                onReact(emoji);
                onClose();
              }}
              onMore={() => setPicking(true)}
              moreRef={moreRef}
            />
          ) : null}
          {items.map((item) => (
            <MenuRow key={item.key} item={item} onRun={run} />
          ))}
        </div>
      ) : null}
      {active ? (
        <EmojiPickerShell
          open={picking}
          onClose={() => setPicking(false)}
          layout={layout}
          returnFocus={moreRef}
          anchor={containerRef.current?.getBoundingClientRect() ?? anchor}
          onPick={(emoji) =>
            pickReaction(emoji, {
              onReact,
              closePicker: () => setPicking(false),
              closeMenu: onClose,
            })
          }
        />
      ) : null}
    </>,
    document.body,
  );
}
