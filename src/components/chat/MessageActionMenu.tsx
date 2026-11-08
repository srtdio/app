// The message action menu (L10, 8 Nov 2026). Phone: a ui/Sheet with a grab
// handle and no title: a row of round quick reactions plus "+", three big
// tiles (Reply, Forward, Add to Tasks), the rows Mark unread, Copy link and
// Copy text, a divider, then "More actions ›", which opens a second page
// ("<" More actions): Reply privately (with "to <Name>"), Select text,
// Transcribe, Save to notes, Edit, Remove file, a divider, Delete (danger).
// Laptop (right-click): the same groups and order in a MenuPopover, the tiles
// drawn as its first three rows. Each entry shows only when it applies (plan
// and idea cards hide Forward, Add to Tasks, Save to notes and Edit as
// before); Edit and Delete keep their "15 min" / "30 min" hints. Remind,
// Star and Mark as stay removed.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { growFromTrigger, riseIn, trackDim } from '@/lib/motion';
import { menuOrigin } from '@/components/ui/popover-classes';
import { createPortal } from 'react-dom';
import {
  ICON_SIZE,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconFile,
  IconForward,
  IconLink,
  IconMail,
  IconPlus,
  IconReply,
  IconReplyPrivately,
  IconSelectText,
  IconTaskSquare,
  IconText,
  IconTrash,
} from '@/components/ui/icons';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { Button } from '@/components/ui/Button';
import { Backdrop } from '@/components/ui/Backdrop';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { useIsLaptop, viewportSize } from '@/lib/use-is-laptop';
import { useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
import { logger } from '@/lib/logger';
import { DELETE_SELECTION_WINDOW_MS } from '@/lib/chat/forward';
import type { ThreadMessage } from '@/lib/chat/thread';
import { cn } from '@/lib/cn';
import { REMOVE_FILE_MENU_LABEL } from '@/lib/chat/remove-files';
import { useModalFocus } from '@/lib/modal-focus';
import { moveMenuFocus } from '@/lib/chat/menu-keys';
import { REPLY_PRIVATELY, replyPrivatelyTo } from '@/lib/chat/private-reply';
import { personFirstName } from '@/lib/person-card';
import { errorText } from '@/lib/error-copy';

/** Quick-react row offered when a message's action menu is opened; "+" opens the picker after it. */
// L9 (8 Nov 2026): ✅ replaces 👌. ✅ is a reaction only; it never means approval anywhere.
export const QUICK_REACTIONS = ['👍', '✅', '❤️', '😂', '🙏'] as const;

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

/** The own-message rows a message offers when its menu opens. */
export interface OwnMessageActions {
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * Edit and Delete for one message at `nowMs` (the moment the menu opens). Only
 * the caller's own recorded, live message qualifies; the windows run
 * from the server created_at (a pending message has none, so neither row
 * shows). Edit also needs a body: attachments, cards and mentions are never
 * editable. Mirrors chat_message_edit / chat_message_delete. Pure.
 */
export function ownMessageActions(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'createdAt' | 'body' | 'deleted'>,
  nowMs: number,
  /** Notes: no window on Edit or Delete. */
  notes = false,
): OwnMessageActions {
  // Notes: neither Edit nor Delete has a window.
  const none = { canEdit: false, canDelete: false };
  if (!message.mine || message.state !== 'sent' || message.deleted === true) return none;
  if (message.createdAt === '') return none;
  const created = Date.parse(message.createdAt);
  if (Number.isNaN(created)) return none;
  const age = nowMs - created;
  return {
    canEdit: message.body.trim() !== '' && (notes || age <= EDIT_WINDOW_MS),
    canDelete: notes || age <= DELETE_WINDOW_MS,
  };
}

/**
 * A plan card message (chat_plan_share): its menu hides Forward, Save to notes
 * and Edit; Reply, Copy (the plan's title) and Delete stay. Pure.
 */
export function isPlanMessage(message: Pick<ThreadMessage, 'sharedPlanIds'>): boolean {
  return (message.sharedPlanIds ?? []).length > 0;
}

/**
 * An idea card message (chat_plan_item_share): the same menu rules as a plan
 * card (no Forward, Save to notes or Edit; Copy copies the idea's title). Pure.
 */
export function isIdeaMessage(message: Pick<ThreadMessage, 'sharedPlanItemIds'>): boolean {
  return (message.sharedPlanItemIds ?? []).length > 0;
}

/**
 * Whether a selection can be forwarded: never when it holds a plan or idea
 * card (shared with chat_plan_share / chat_plan_item_share, not forwarded as
 * a message). Pure.
 */
export function selectionForwardable(
  selected: ReadonlySet<string>,
  messages: ReadonlyArray<Pick<ThreadMessage, 'id' | 'sharedPlanIds' | 'sharedPlanItemIds'>>,
): boolean {
  return !messages.some((m) => selected.has(m.id) && (isPlanMessage(m) || isIdeaMessage(m)));
}

interface MessageActionMenuProps {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
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
  onReact: (emoji: string) => void;
  onReply: () => void;
  /**
   * Offers "Reply privately" right under Reply (see canReplyPrivately: someone
   * else's message in a group, from a current member).
   */
  canReplyPrivately?: boolean;
  /** The sender's display name; the row's grey hint reads "to <first name>". */
  replyPrivatelyName?: string;
  onReplyPrivately?: () => void;
  onCopy: () => void;
  /** Offers "Forward" (a recorded message, anyone's). */
  canForward?: boolean;
  onForward?: () => void;
  /** Offers "Edit" (see ownMessageActions). */
  canEdit?: boolean;
  onEdit?: () => void;
  /** Offers "Delete" (see ownMessageActions). */
  canDelete?: boolean;
  onDelete?: () => void;
  /**
   * A failed own send (never recorded): Delete removes it from this device,
   * so it carries no "30 min" hint.
   */
  failedSend?: boolean;
  /**
   * Delete offers only "Delete for me" (someone else's message, or an own one
   * past the window): the row carries no "30 min" hint.
   */
  deleteForMeOnly?: boolean;
  /**
   * Offers "Save to notes" (a recorded, live
   * message in any chat but notes).
   */
  canSaveToNotes?: boolean;
  onSaveToNotes?: () => void;
  /** The menu is in Personal notes: Edit and Delete carry no time hint. */
  notes?: boolean;
  /**
   * Offers "Select": select part of this message's body text in place (a
   * recorded, live message with a typed body, never a voice note alone).
   */
  canSelectText?: boolean;
  onSelectText?: () => void;
  /**
   * Offers "Remove file", last under More: an own, unmarked message with
   * exactly one file that is not a voice note (canRemoveSingleFile). The
   * message stays; the file goes behind an Undo.
   */
  canRemoveFile?: boolean;
  onRemoveFile?: () => void;
  /** L11: Mark unread (a recorded message from someone else). */
  canMarkUnread?: boolean;
  onMarkUnread?: () => void;
  /** L12: Add to Tasks (a chat with a Tasks list; not on plan or idea cards). */
  canAddToTasks?: boolean;
  onAddToTasks?: () => void;
  /** L13: Copy link (a recorded message). */
  canCopyLink?: boolean;
  onCopyLink?: () => void;
}

/** Where an entry sits (L10): a big tile, a row on the first page, or under More actions. */
export type MenuGroup = 'tile' | 'row' | 'more';

/** One entry of the message action menu. */
export interface MessageMenuItem {
  kind: 'action';
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  /** The entry's group; absent reads as 'more'. */
  group?: MenuGroup;
  /** Text in the bad token (Delete). */
  danger?: boolean;
  /** Muted note at the right ("15 min"). */
  hint?: string;
}

type MenuItemProps = Pick<
  MessageActionMenuProps,
  | 'canCopy'
  | 'onReply'
  | 'canReplyPrivately'
  | 'replyPrivatelyName'
  | 'onReplyPrivately'
  | 'onCopy'
  | 'canTranscribe'
  | 'onTranscribe'
  | 'canForward'
  | 'onForward'
  | 'canEdit'
  | 'onEdit'
  | 'canDelete'
  | 'onDelete'
  | 'failedSend'
  | 'deleteForMeOnly'
  | 'canSaveToNotes'
  | 'onSaveToNotes'
  | 'notes'
  | 'canSelectText'
  | 'onSelectText'
  | 'canRemoveFile'
  | 'onRemoveFile'
  | 'canMarkUnread'
  | 'onMarkUnread'
  | 'canAddToTasks'
  | 'onAddToTasks'
  | 'canCopyLink'
  | 'onCopyLink'
>;

/** L10 labels. */
export const ADD_TO_TASKS_LABEL = 'Add to Tasks';
export const MARK_UNREAD_LABEL = 'Mark unread';
export const COPY_LINK_LABEL = 'Copy link';
export const COPY_TEXT_LABEL = 'Copy text';
export const MORE_ACTIONS_LABEL = 'More actions';

/** The menu row that copies a message into Personal notes. */
export const SAVE_TO_NOTES_LABEL = 'Save to notes';

/**
 * A row's tap, inside its click: the action runs before the menu closes, so
 * Reply focuses the composer within the user's own tap (decision 128) and the
 * menu's focus return finds focus already taken. Pure.
 */
export function runMenuItem(item: MessageMenuItem, menu: { close: () => void }): void {
  item.run();
  menu.close();
}

/** Every menu row's glyph size, phone sheet and laptop popover alike (ICON_SIZE.tray). */
export const MENU_ICON_SIZE = ICON_SIZE.tray;

/** The row that selects part of one message's text in place. */
export const SELECT_TEXT_LABEL = 'Select text';

/**
 * The entries in display order (L10). Tiles: Reply, Forward, Add to Tasks.
 * Rows: Mark unread, Copy link, Copy text. More actions: Reply privately,
 * Select text, Transcribe, Save to notes, Edit, then the danger rows Remove
 * file and Delete (last). Entries that do not apply are not returned; the
 * divider before the danger rows is the renderer's (dividerBefore). Pure (no
 * hooks) so the set is unit-tested without a DOM.
 */
export function messageMenuItems(
  props: MenuItemProps,
  size: number = MENU_ICON_SIZE,
): MessageMenuItem[] {
  const items: MessageMenuItem[] = [
    {
      kind: 'action',
      key: 'reply',
      label: 'Reply',
      icon: <IconReply size={size} />,
      group: 'tile',
      run: props.onReply,
    },
  ];
  if (props.canForward === true) {
    items.push({
      kind: 'action',
      key: 'forward',
      label: 'Forward',
      icon: <IconForward size={size} />,
      group: 'tile',
      run: () => props.onForward?.(),
    });
  }
  if (props.canAddToTasks === true) {
    items.push({
      kind: 'action',
      key: 'add-task',
      label: ADD_TO_TASKS_LABEL,
      icon: <IconTaskSquare size={size} />,
      group: 'tile',
      run: () => props.onAddToTasks?.(),
    });
  }
  if (props.canMarkUnread === true) {
    items.push({
      kind: 'action',
      key: 'mark-unread',
      label: MARK_UNREAD_LABEL,
      icon: <IconMail size={size} />,
      group: 'row',
      run: () => props.onMarkUnread?.(),
    });
  }
  if (props.canCopyLink === true) {
    items.push({
      kind: 'action',
      key: 'copy-link',
      label: COPY_LINK_LABEL,
      icon: <IconLink size={size} />,
      group: 'row',
      run: () => props.onCopyLink?.(),
    });
  }
  if (props.canCopy) {
    items.push({
      kind: 'action',
      key: 'copy',
      label: COPY_TEXT_LABEL,
      icon: <IconCopy size={size} />,
      group: 'row',
      run: props.onCopy,
    });
  }
  if (props.canReplyPrivately === true) {
    const first = personFirstName(props.replyPrivatelyName ?? '');
    items.push({
      kind: 'action',
      key: 'reply-privately',
      label: REPLY_PRIVATELY,
      icon: <IconReplyPrivately size={size} />,
      ...(first !== '' ? { hint: replyPrivatelyTo(first) } : {}),
      group: 'more',
      run: () => props.onReplyPrivately?.(),
    });
  }
  if (props.canSelectText === true) {
    items.push({
      kind: 'action',
      key: 'select-text',
      label: SELECT_TEXT_LABEL,
      icon: <IconSelectText size={size} />,
      group: 'more',
      run: () => props.onSelectText?.(),
    });
  }
  if (props.canTranscribe === true) {
    items.push({
      kind: 'action',
      key: 'transcribe',
      label: 'Transcribe',
      icon: <IconText size={size} />,
      group: 'more',
      run: () => props.onTranscribe?.(),
    });
  }
  if (props.canSaveToNotes === true) {
    items.push({
      kind: 'action',
      key: 'save-notes',
      label: SAVE_TO_NOTES_LABEL,
      icon: <IconFile size={size} />,
      group: 'more',
      run: () => props.onSaveToNotes?.(),
    });
  }
  if (props.canEdit === true) {
    items.push({
      kind: 'action',
      key: 'edit',
      label: 'Edit',
      icon: <IconEdit size={size} />,
      ...(props.notes === true ? {} : { hint: '15 min' }),
      group: 'more',
      run: () => props.onEdit?.(),
    });
  }
  if (props.canRemoveFile === true) {
    items.push({
      kind: 'action',
      key: 'remove-file',
      label: REMOVE_FILE_MENU_LABEL,
      icon: <IconTrash size={size} />,
      danger: true,
      group: 'more',
      run: () => props.onRemoveFile?.(),
    });
  }
  if (props.canDelete === true) {
    items.push({
      kind: 'action',
      key: 'delete',
      label: 'Delete',
      icon: <IconTrash size={size} />,
      ...(props.notes === true || props.failedSend === true || props.deleteForMeOnly === true
        ? {}
        : { hint: '30 min' }),
      danger: true,
      group: 'more',
      run: () => props.onDelete?.(),
    });
  }
  return items;
}

/** The entries of one group, in order. Pure. */
export function itemsOfGroup(
  items: readonly MessageMenuItem[],
  group: MenuGroup,
): MessageMenuItem[] {
  return items.filter((item) => (item.group ?? 'more') === group);
}

/**
 * Where the one divider goes: before the first danger row, when one follows
 * another row; null when no danger row shows (or a danger row is alone). Pure.
 */
export function dividerBefore(items: readonly MessageMenuItem[]): number | null {
  const at = items.findIndex((item) => item.danger === true);
  return at > 0 ? at : null;
}

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

/** A row's box: full-bleed, at least 44px, 16px side padding, 12px to the label. */
export const MENU_ROW = 'flex min-h-11 w-full items-center gap-3 px-4';

/**
 * One row, ActionMenu's row look: base text, the icon left in the row's ink,
 * Delete in bad, a muted sm hint right.
 */
export function MenuRow(props: {
  item: MessageMenuItem;
  onRun: (item: MessageMenuItem) => void;
}): ReactElement {
  const item = props.item;
  return (
    <PressableRow
      flat
      type="button"
      role="menuitem"
      data-menu-item={item.key}
      onClick={() => props.onRun(item)}
      className={cn(
        MENU_ROW,
        'text-base mv-tint focus-visible:bg-panel-2',
        item.danger === true ? 'text-bad' : 'text-fg',
      )}
    >
      <span data-menu-icon="" className="flex w-6 shrink-0 items-center justify-center">
        {item.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint !== undefined ? (
        <span className="shrink-0 text-sm text-fg-3">{item.hint}</span>
      ) : null}
    </PressableRow>
  );
}

/**
 * A big tile on the phone sheet (L10): the icon over the label, 72 tall, a
 * hairline card, one third of the row. Laptop draws the same entry as a row.
 */
export function MenuTile(props: {
  item: MessageMenuItem;
  onRun: (item: MessageMenuItem) => void;
}): ReactElement {
  const item = props.item;
  return (
    <PressableRow
      card
      type="button"
      role="menuitem"
      data-menu-item={item.key}
      data-menu-tile=""
      align="center"
      onClick={() => props.onRun(item)}
      className="flex min-h-18 min-w-0 flex-1 flex-col items-center justify-center gap-1 border border-border px-2 text-md text-fg"
    >
      <span data-menu-icon="" className="flex items-center justify-center">
        {item.icon}
      </span>
      <span className="min-w-0 max-w-full truncate">{item.label}</span>
    </PressableRow>
  );
}

/**
 * The laptop popover's width. Six 44x44 reaction cells (the touch-target
 * floor), the row's 10px sides and the 1px border each side need 286px.
 */
export const MENU_WIDTH_PX = 286;

/** The visible viewport's bottom in layout px: visualViewport (the iOS keyboard) when present. */
export function visibleViewportHeight(win: {
  innerHeight: number;
  visualViewport?: { height: number; offsetTop: number } | null;
}): number {
  const vv = win.visualViewport;
  return vv != null ? vv.offsetTop + vv.height : win.innerHeight;
}

/**
 * The menu panel's max height: the visible viewport less 16px (8px each
 * side), so a long menu on a small phone scrolls inside instead of running
 * off screen. Pure.
 */
export function menuMaxHeight(viewportHeight: number): number {
  return Math.max(0, viewportHeight - 16);
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
      // 8px around six 44x44 cells; one hairline under it (the menu's only divider).
      className={cn(
        'flex items-center justify-between px-2 py-2',
        !reactionsOnly && 'border-b border-border',
      )}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <IconButton
          key={emoji}
          type="button"
          label={`React ${emoji}`}
          aria-pressed={emoji === currentReaction}
          {...(reactionsOnly ? { 'data-menu-item': `react-${emoji}` } : {})}
          onClick={() => props.onReact(emoji)}
          className={cn(
            // L10: round reaction buttons, 44 and up.
            'h-12 w-12 shrink-0 rounded-full text-2xl',
            emoji === currentReaction && 'border bg-panel lit-selected',
          )}
        >
          <span aria-hidden="true">{emoji}</span>
        </IconButton>
      ))}
      <IconButton
        buttonRef={props.moreRef}
        type="button"
        data-react-more=""
        label={MORE_REACTIONS_LABEL}
        aria-haspopup="dialog"
        {...(reactionsOnly ? { 'data-menu-item': 'react-more' } : {})}
        onClick={props.onMore}
        className="h-12 w-12 shrink-0 rounded-full bg-panel-2"
      >
        <IconPlus size={ICON_SIZE.control} />
      </IconButton>
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

/** Whether a scroll event came from the menu panel itself (a long menu scrolling inside). */
export function scrollFromMenu(
  menu: { contains: (node: Node | null) => boolean } | null,
  target: EventTarget | null,
): boolean {
  return (
    menu !== null && typeof Node !== 'undefined' && target instanceof Node && menu.contains(target)
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

/** The laptop popover's size (the touch sheet is 70dvh). */
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

/** The picker body's load failure line (never the raw error). */
export const EMOJI_LOAD_FAILED = errorText('load emoji', null);

/** What the picker shell shows under its frame. Pure. */
export function pickerBodyState(
  module: EmojiPickerModule | null,
  failed: boolean,
): 'ready' | 'failed' | 'loading' {
  if (module !== null) return 'ready';
  return failed ? 'failed' : 'loading';
}

/** The grid area when the picker chunk failed to load: the line and a 44x44 Retry. */
export function EmojiPickerLoadFailed(props: { onRetry: () => void }): ReactElement {
  return (
    <div
      data-emoji-failed=""
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <p className="text-base text-fg-3">{EMOJI_LOAD_FAILED}</p>
      <Button type="button" data-emoji-retry="" className="min-w-11" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * The emoji picker's shell. Touch: a bottom sheet over a dim that rises
 * (riseIn, Y only, the dim tracking its position), the safe-area inset kept
 * clear. Laptop: a modal popover anchored to `anchor` that grows from it
 * (growFromTrigger). Never a fade. Both are drawn at their final size at once; the body
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLButtonElement>(null);
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

  // Entrance on the first painted frame (drawn at rest; the move laid over it).
  const anchorRef = useRef(props.anchor);
  anchorRef.current = props.anchor;
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (!open || el === null) return;
    if (layout === 'laptop') {
      const a = anchorRef.current;
      growFromTrigger(
        el,
        menuOrigin(el, a !== null ? { x: a.left + a.width / 2, y: a.top + a.height / 2 } : null),
      );
      return;
    }
    trackDim(el, dimRef.current, riseIn(el));
  }, [open, layout]);

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
  // FB2: the picker is a modal layer in X1's focus stack: Tab stays inside
  // (only the top layer traps). Its own effect above already placed focus
  // inside and returnPickerFocus hands it back to "+".
  useModalFocus(dialogRef, open);

  if (!open) return null;

  const close = (
    // Dismiss is the ghost "Clear" text Button (44 tall), never an X.
    <Button
      type="button"
      variant="ghost"
      aria-label="Close emoji picker"
      data-emoji-close=""
      className="shrink-0 px-3"
      onClick={onClose}
    >
      Clear
    </Button>
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
            className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-panel-2 lit-well"
          />
          {close}
        </div>
        <div aria-hidden="true" className="h-11 shrink-0 border-b border-border lit-well" />
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
  } as const;

  if (layout === 'laptop') {
    const position = props.anchor !== null ? popoverPosition(props.anchor, viewportSize()) : null;
    return createPortal(
      <>
        <div data-emoji-dismiss="" className="fixed inset-0 z-dialog" onClick={onClose} />
        <div
          {...dialogProps}
          data-emoji-picker="laptop"
          className="fixed z-dialog flex h-emoji w-emoji max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border bg-panel lit-overlay focus:outline-none"
          style={{ top: position?.top ?? 8, left: position?.left ?? 8 }}
        >
          {body}
        </div>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div data-emoji-dismiss="" className="fixed inset-0 z-dialog">
      <Backdrop
        ref={dimRef}
        aria-label="Close emoji picker"
        onClick={onClose}
        position="absolute"
      />
      <div
        {...dialogProps}
        data-emoji-picker="touch"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 bottom-0 flex h-[70dvh] flex-col overflow-hidden rounded-t-2xl border-t bg-panel pb-[env(safe-area-inset-bottom)] lit-overlay focus:outline-none"
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The message action menu, opened by long-press (touch), right-click, the
 * hover ⋯ control (pointer devices) or Enter / Space on a focused bubble. The
 * one ⋯ container rule (ui/ActionMenu): phone (useIsLaptop false) a ui/Sheet,
 * laptop a shell/MenuPopover anchored under the bubble on its side (lifted to
 * stay on screen). The quick reactions sit on top (hairline under them), then
 * the rows, one level, a hairline before the danger rows. It focuses the first row on open and hands focus back on close.
 * The laptop popover also closes on scroll or resize (never while the emoji
 * picker is open). Tokens only, so light and dark stay at parity.
 */
export function MessageActionMenu(props: MessageActionMenuProps): ReactElement | null {
  const { open, onClose, anchor, mine, currentReaction, onReact } = props;
  const isLaptop = useIsLaptop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  const moreRef = useRef<HTMLButtonElement>(null);
  const layout = useChatLayout();
  // Laptop: how far the popover lifts so its bottom stays on screen.
  const [lift, setLift] = useState(0);

  // The picker's chunk starts loading as the menu opens, so "+" opens it ready.
  useEffect(() => {
    if (!open || loadedEmojiPicker() !== null) return;
    loadEmojiPicker().catch((error: unknown) =>
      logger.warn('chat: emoji picker preload failed', { error: String(error) }),
    );
  }, [open]);

  useEffect(() => {
    if (open) return;
    setPicking(false);
  }, [open]);

  // Laptop: measured under the bubble, then lifted by any overflow past the
  // visible bottom (never above the viewport's top margin).
  useLayoutEffect(() => {
    if (!open || !isLaptop || anchor === null) {
      setLift(0);
      return;
    }
    const panel = containerRef.current?.parentElement ?? null;
    if (panel === null) return;
    const overflow = anchor.bottom + 8 + panel.offsetHeight - (visibleViewportHeight(window) - 8);
    setLift(overflow > 0 ? Math.min(overflow, Math.max(0, anchor.bottom - 8)) : 0);
  }, [open, isLaptop, anchor]);

  // Focus the first row on open; hand it back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const raf = requestAnimationFrame(() => focusFirstMenuItem(containerRef.current));
    return () => {
      cancelAnimationFrame(raf);
      // Only when nothing else took focus (Reply may focus the composer).
      const current = document.activeElement;
      const idle = current === null || current === document.body;
      if (idle && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    focusFirstMenuItem(containerRef.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (menuClosesOnKey(event.key)) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // The laptop popover sits at the bubble's rect: a scroll outside it or any
  // resize closes it, except while the picker is open (the keyboard, iOS
  // scrolling its input into view). The phone sheet stays put on its own.
  useEffect(() => {
    if (!open || !isLaptop) return;
    function onScroll(event: Event): void {
      // A long menu scrolls inside itself: that never closes it.
      if (scrollFromMenu(containerRef.current, event.target)) return;
      if (menuClosesOnViewport('scroll', { picking: pickingRef.current, target: event.target })) {
        onClose();
      }
    }
    function onResize(): void {
      if (menuClosesOnViewport('resize', { picking: pickingRef.current, target: null })) {
        onClose();
      }
    }
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, isLaptop, onClose]);

  const active = open && anchor !== null;
  const reactionsOnly = props.reactionsOnly === true;
  const size = MENU_ICON_SIZE;
  const items = !active || reactionsOnly ? [] : messageMenuItems(props, size);
  const tiles = itemsOfGroup(items, 'tile');
  const rows = itemsOfGroup(items, 'row');
  const more = itemsOfGroup(items, 'more');
  const divider = dividerBefore(more);
  // L10: the first page, or the "More actions" page.
  const [page, setPage] = useState<'main' | 'more'>('main');
  useEffect(() => {
    if (!open) setPage('main');
  }, [open]);
  useEffect(() => {
    if (open) focusFirstMenuItem(containerRef.current);
  }, [open, page]);
  const run = (item: MessageMenuItem): void => {
    runMenuItem(item, { close: onClose });
  };
  const moreRow =
    more.length > 0 ? (
      <PressableRow
        flat
        type="button"
        role="menuitem"
        data-menu-item="more-actions"
        aria-haspopup="menu"
        onClick={() => setPage('more')}
        className={cn(MENU_ROW, 'text-base mv-tint focus-visible:bg-panel-2 text-fg')}
      >
        <span className="min-w-0 flex-1 truncate">{MORE_ACTIONS_LABEL}</span>
        <IconChevronRight size={ICON_SIZE.control} className="shrink-0 text-fg-3" />
      </PressableRow>
    ) : null;

  const body = (
    <div
      ref={containerRef}
      role="menu"
      aria-label="Message actions"
      data-menu-items=""
      onKeyDown={(event) => {
        // FB2: arrow keys move between items.
        if (moveMenuFocus(containerRef.current, event.key)) event.preventDefault();
      }}
      className={cn('flex flex-col', isLaptop && '-m-2 overflow-y-auto overscroll-contain')}
      style={
        isLaptop
          ? { width: MENU_WIDTH_PX, maxHeight: menuMaxHeight(visibleViewportHeight(window)) }
          : undefined
      }
    >
      {page === 'more' ? (
        <div data-menu-page="more" className="flex flex-col">
          <HeaderBar compact title={MORE_ACTIONS_LABEL} onBack={() => setPage('main')} />
          {more.map((item, index) => (
            <Fragment key={item.key}>
              {index === divider ? (
                <div aria-hidden="true" data-menu-divider="" className="border-t border-border" />
              ) : null}
              <MenuRow item={item} onRun={run} />
            </Fragment>
          ))}
        </div>
      ) : null}
      {page === 'main' && props.canReact !== false ? (
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
      {page === 'main' && tiles.length > 0 ? (
        isLaptop ? (
          tiles.map((item) => <MenuRow key={item.key} item={item} onRun={run} />)
        ) : (
          <div data-menu-tiles="" className="flex gap-2 py-2">
            {tiles.map((item) => (
              <MenuTile key={item.key} item={item} onRun={run} />
            ))}
          </div>
        )
      ) : null}
      {page === 'main'
        ? rows.map((item) => <MenuRow key={item.key} item={item} onRun={run} />)
        : null}
      {page === 'main' && moreRow !== null ? (
        <>
          <div aria-hidden="true" data-menu-divider="" className="border-t border-border" />
          {moreRow}
        </>
      ) : null}
    </div>
  );

  const picker = active ? (
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
  ) : null;

  if (!isLaptop) {
    return (
      <>
        <Sheet open={active} onClose={onClose} title="Message actions" handle>
          {active ? body : null}
        </Sheet>
        {picker}
      </>
    );
  }
  if (!active || anchor === null) return null;
  return createPortal(
    <>
      <span
        data-menu-anchor=""
        className="fixed z-sheet"
        style={{ top: anchor.bottom - lift, left: mine ? anchor.right : anchor.left }}
      >
        <span className="relative block">
          <MenuPopover
            open
            onClose={onClose}
            align={mine ? 'right' : 'left'}
            label="Message actions"
            menu={false}
          >
            {body}
          </MenuPopover>
        </span>
      </span>
      {picker}
    </>,
    document.body,
  );
}
