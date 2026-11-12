// The message action menu (L10, 8 Nov 2026; order locked in Thread polish 2,
// 11 Nov 2026). Phone: a ui/Sheet with a grab handle and no title. Top to
// bottom, each entry only where it applies: a row of six round quick
// reactions plus the smiley key (seven 44 circles edge to edge); three big
// tiles (Reply, Forward, Add to Tasks); the rows Mark unread and Edit; a
// divider; Copy link, Copy text, Select text, Save to notes, Reply privately
// (with "to <Name>"), Transcribe; a divider; the danger rows Remove file, then
// Delete, always last. One page: no "More actions" row, no second page. A
// divider sits only between two groups that both show (menuEntries). A list
// taller than the sheet scrolls inside it; the reactions row stays put.
// Laptop (right-click): the same entries, order and dividers in a MenuPopover,
// the tiles drawn as its first rows. Plan and idea cards hide Forward, Add to
// Tasks, Save to notes and Edit as before; Edit and Delete keep their
// "15 min" / "30 min" hints. Remind, Star and Mark as stay removed.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  ICON_SIZE,
  IconCopy,
  IconEdit,
  IconFile,
  IconForward,
  IconLink,
  IconMail,
  IconReply,
  IconReplyPrivately,
  IconSelectText,
  IconSmile,
  IconTaskSquare,
  IconText,
  IconTrash,
} from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { DELETE_SELECTION_WINDOW_MS } from '@/lib/chat/forward';
import type { ThreadMessage } from '@/lib/chat/thread';
import { cn } from '@/lib/cn';
import { REMOVE_FILE_MENU_LABEL } from '@/lib/chat/remove-files';
import { moveMenuFocus } from '@/lib/chat/menu-keys';
import { REPLY_PRIVATELY, replyPrivatelyTo } from '@/lib/chat/private-reply';
import { personFirstName } from '@/lib/person-card';
import { AddReactionSheet } from '@/components/ui/ReactionChips';

/** Quick-react row offered when a message's action menu is opened; the smiley key opens the picker after it. */
// L9 (8 Nov 2026): ✅ replaces 👌. ✅ is a reaction only; it never means approval anywhere.
// Thread polish 1 (11 Nov 2026): six, 👏 last. PersonMessageInput reads the first three.
export const QUICK_REACTIONS = ['👍', '✅', '❤️', '😂', '🙏', '👏'] as const;

/** The smiley key after the quick reactions: opens the full emoji picker. */
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
   * Offers "Reply"; default true. False inside a thread view: every message
   * there is already in the thread, so it has no Reply (no tile, no gesture).
   */
  canReply?: boolean;
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

/**
 * Where an entry sits: a big tile, a lead row under the tiles (Mark unread,
 * Edit), a tools row (the copy group), or a danger row (last).
 */
export type MenuGroup = 'tile' | 'row' | 'tools' | 'danger';

/** One entry of the message action menu. */
export interface MessageMenuItem {
  kind: 'action';
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  /** The entry's group; absent reads as 'tools'. */
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
  | 'canReply'
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
/** The replies bar's three-dot key (ThreadRail); the sheet itself has no such row or page. */
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
 * The entries in display order (Thread polish 2, locked). Tiles: Reply,
 * Forward, Add to Tasks. Rows: Mark unread, Edit. Tools: Copy link, Copy text,
 * Select text, Save to notes, Reply privately, Transcribe. Danger: Remove
 * file, then Delete (always the last entry). Entries that do not apply are
 * not returned; the dividers are menuEntries'. Pure (no hooks) so the set is
 * unit-tested without a DOM.
 */
export function messageMenuItems(
  props: MenuItemProps,
  size: number = MENU_ICON_SIZE,
): MessageMenuItem[] {
  const items: MessageMenuItem[] = [];
  if (props.canReply !== false) {
    items.push({
      kind: 'action',
      key: 'reply',
      label: 'Reply',
      icon: <IconReply size={size} />,
      group: 'tile',
      run: props.onReply,
    });
  }
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
  if (props.canEdit === true) {
    items.push({
      kind: 'action',
      key: 'edit',
      label: 'Edit',
      icon: <IconEdit size={size} />,
      ...(props.notes === true ? {} : { hint: '15 min' }),
      group: 'row',
      run: () => props.onEdit?.(),
    });
  }
  if (props.canCopyLink === true) {
    items.push({
      kind: 'action',
      key: 'copy-link',
      label: COPY_LINK_LABEL,
      icon: <IconLink size={size} />,
      group: 'tools',
      run: () => props.onCopyLink?.(),
    });
  }
  if (props.canCopy) {
    items.push({
      kind: 'action',
      key: 'copy',
      label: COPY_TEXT_LABEL,
      icon: <IconCopy size={size} />,
      group: 'tools',
      run: props.onCopy,
    });
  }
  if (props.canSelectText === true) {
    items.push({
      kind: 'action',
      key: 'select-text',
      label: SELECT_TEXT_LABEL,
      icon: <IconSelectText size={size} />,
      group: 'tools',
      run: () => props.onSelectText?.(),
    });
  }
  if (props.canSaveToNotes === true) {
    items.push({
      kind: 'action',
      key: 'save-notes',
      label: SAVE_TO_NOTES_LABEL,
      icon: <IconFile size={size} />,
      group: 'tools',
      run: () => props.onSaveToNotes?.(),
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
      group: 'tools',
      run: () => props.onReplyPrivately?.(),
    });
  }
  if (props.canTranscribe === true) {
    items.push({
      kind: 'action',
      key: 'transcribe',
      label: 'Transcribe',
      icon: <IconText size={size} />,
      group: 'tools',
      run: () => props.onTranscribe?.(),
    });
  }
  if (props.canRemoveFile === true) {
    items.push({
      kind: 'action',
      key: 'remove-file',
      label: REMOVE_FILE_MENU_LABEL,
      icon: <IconTrash size={size} />,
      danger: true,
      group: 'danger',
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
      group: 'danger',
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
  return items.filter((item) => (item.group ?? 'tools') === group);
}

/** A hairline between two groups of the menu. */
export const MENU_DIVIDER = 'divider' as const;

/** What the menu draws under the reactions row, in order: an entry or a divider. */
export type MenuEntry = MessageMenuItem | typeof MENU_DIVIDER;

/** The row groups under the tiles, in display order. */
const ROW_GROUPS = ['row', 'tools', 'danger'] as const;

/**
 * The one list the sheet and the laptop popover draw (no second page): the
 * tiles, the lead rows (they continue the tiles' block, no divider), then the
 * tools and the danger rows, each behind a divider when anything shows above
 * it. So a divider only ever sits between two groups that both show: never
 * first, never last, never doubled. Pure.
 */
export function menuEntries(items: readonly MessageMenuItem[]): MenuEntry[] {
  const out: MenuEntry[] = [...itemsOfGroup(items, 'tile')];
  for (const group of ROW_GROUPS) {
    const rows = itemsOfGroup(items, group);
    if (rows.length === 0) continue;
    if (group !== 'row' && out.length > 0) out.push(MENU_DIVIDER);
    out.push(...rows);
  }
  return out;
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

/**
 * How the last interaction came in: a key (true) or a pointer / touch (false).
 * Read when the menu opens, so a long-press or tap open never lands focus on
 * a row with its ring showing (iOS WebKit matches :focus-visible on a
 * programmatic focus after a touch); a keyboard open still lands on Reply.
 */
let lastInputKeyboard = false;
let modalityWatched = false;

/** Install the one capture listener pair (idempotent; no-op without a document). */
export function watchInputModality(): void {
  if (modalityWatched || typeof document === 'undefined') return;
  modalityWatched = true;
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.metaKey || event.altKey || event.ctrlKey) return;
      lastInputKeyboard = true;
    },
    true,
  );
  const pointer = (): void => {
    lastInputKeyboard = false;
  };
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('touchstart', pointer, { capture: true, passive: true });
}

/** Whether the menu opened from the keyboard (Enter / Space on a bubble, a shortcut). */
export function openedByKeyboard(): boolean {
  return lastInputKeyboard;
}

/**
 * Where focus lands when the menu opens: the first action row when the open
 * came from the keyboard; otherwise the menu box itself (tabIndex -1, no
 * outline), so a touch or long-press open shows no ring on the first tile and
 * Tab still starts at Reply. Returns whether focus moved.
 */
export function focusMenuOnOpen(
  root: (MenuRoot & { focus: (options?: FocusOptions) => void }) | null,
  keyboard: boolean,
): boolean {
  if (root === null) return false;
  if (keyboard) return focusFirstMenuItem(root);
  root.focus({ preventScroll: true });
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
      // Full-bleed in a scrolling list: the focus line sits inside the edge, never clipped.
      insetFocus
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
      // The first tile sits on the list's left edge (overflow clips outside it):
      // the keyboard focus line is drawn inside the tile, never cut.
      insetFocus
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
      {/* Never cut: a label that does not fit one line ("Add to Tasks" on a
          narrow phone) wraps to two centred lines; the row stretches every
          tile to one height. */}
      <span className="min-w-0 max-w-full text-center">{item.label}</span>
    </PressableRow>
  );
}

/**
 * The laptop popover's width. Seven 44x44 reaction circles (six quick
 * reactions and the smiley key), the row's 16px sides (MENU_ROW's inset) and
 * the 1px border each side need 342px.
 */
export const MENU_WIDTH_PX = 342;

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

/** ui/Sheet's tallest box as a share of the visible viewport (84svh from sm, 90 on a phone: the smaller). */
const SHEET_MAX_SHARE = 0.84;
/** ui/Sheet's own rows around the menu: the 20 grab handle, 8 above and 16 below the body. */
const SHEET_CHROME_PX = 44;

/**
 * The phone sheet's menu max height: what ui/Sheet leaves its body, so a long
 * list scrolls inside the menu (under the reactions row, which stays put)
 * instead of the whole sheet body scrolling. A layout number, no read. Pure.
 */
export function sheetMenuMaxHeight(viewportHeight: number): number {
  return Math.max(0, Math.floor(viewportHeight * SHEET_MAX_SHARE) - SHEET_CHROME_PX);
}

/** The laptop popover keeps this far from the window's side edges. */
const MENU_EDGE_PX = 8;

/**
 * The laptop popover's anchor x: the bubble's side edge (its right for an own
 * message, the popover hangs left of it; else its left, the popover hangs
 * right), clamped so the whole box stays inside the window (the replies
 * bar's three-dot key sits on the right edge). Pure.
 */
export function menuAnchorX(
  anchor: { left: number; right: number },
  mine: boolean,
  viewportWidth: number,
): number {
  const min = MENU_EDGE_PX + (mine ? MENU_WIDTH_PX : 0);
  const max = viewportWidth - MENU_EDGE_PX - (mine ? 0 : MENU_WIDTH_PX);
  return Math.max(min, Math.min(mine ? anchor.right : anchor.left, max));
}

/** One reaction circle: round 44, the last key's bg-panel-2 fill. */
export const REACTION_CIRCLE = 'h-11 w-11 shrink-0 rounded-full bg-panel-2';

/**
 * The reactions row: the six quick reactions, then the smiley key that opens
 * the full picker. Seven round 44 circles, justify-between. On the phone sheet
 * the row has no side padding, so the first and last circle sit on the
 * sheet's content edges; the laptop popover (no padding of its own) insets
 * them 16 like its rows. Hook-free so the tests call it directly.
 */
export function ReactionsRow(props: {
  currentReaction: string | null;
  /** The laptop smiley's row alone: its buttons are the menu's focus stops. */
  reactionsOnly: boolean;
  /** Laptop popover: 16 sides (MENU_ROW's inset); phone sheet: none. */
  inset?: boolean;
  onReact: (emoji: string) => void;
  onMore: () => void;
  /** The smiley key: the picker hands focus back to it on close. */
  moreRef?: RefObject<HTMLButtonElement>;
}): ReactElement {
  const { currentReaction, reactionsOnly } = props;
  return (
    <div
      data-menu-reactions=""
      // 8 above and below seven 44 circles; one hairline under it.
      className={cn(
        'flex shrink-0 items-center justify-between py-2',
        props.inset === true && 'px-4',
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
            // Round 44 circles, filled like the smiley key.
            REACTION_CIRCLE,
            'text-2xl',
            emoji === currentReaction && 'border lit-selected',
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
        className={REACTION_CIRCLE}
      >
        <IconSmile size={ICON_SIZE.control} />
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
    target.closest('[data-emoji-sheet]') !== null
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

/**
 * The message action menu, opened by long-press (touch), right-click, the
 * hover ⋯ control (pointer devices) or Enter / Space on a focused bubble. The
 * one ⋯ container rule (ui/ActionMenu): phone (useIsLaptop false) a ui/Sheet,
 * laptop a shell/MenuPopover anchored under the bubble on its side (lifted to
 * stay on screen). The quick reactions sit on top (hairline under them), then
 * the rows, one page, a hairline between the groups that show (menuEntries). It focuses the first row on a keyboard open (the menu box itself on a
 * touch or long-press open: no ring) and hands focus back on close.
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
  // Laptop: how far the popover lifts so its bottom stays on screen.
  const [lift, setLift] = useState(0);

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

  watchInputModality();

  // Focus on open (the first row from the keyboard, else the menu box: no ring
  // after a touch or long-press); hand it back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const keyboard = openedByKeyboard();
    const raf = requestAnimationFrame(() => focusMenuOnOpen(containerRef.current, keyboard));
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
    focusMenuOnOpen(containerRef.current, openedByKeyboard());
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
  // One page: the rows and their dividers after the tiles (menuEntries).
  const rest = menuEntries(items).slice(tiles.length);
  const run = (item: MessageMenuItem): void => {
    runMenuItem(item, { close: onClose });
  };
  const viewport = active ? visibleViewportHeight(window) : 0;

  const body = (
    <div
      ref={containerRef}
      role="menu"
      aria-label="Message actions"
      data-menu-items=""
      // Takes programmatic focus on a touch / long-press open; never a Tab stop.
      tabIndex={-1}
      onKeyDown={(event) => {
        // FB2: arrow keys move between items.
        if (moveMenuFocus(containerRef.current, event.key)) event.preventDefault();
      }}
      // The reactions row stays put; a long list scrolls under it (data-menu-list).
      className={cn('flex min-h-0 flex-col focus:outline-none', isLaptop && '-m-2')}
      style={
        isLaptop
          ? { width: MENU_WIDTH_PX, maxHeight: menuMaxHeight(viewport) }
          : { maxHeight: sheetMenuMaxHeight(viewport) }
      }
    >
      {props.canReact !== false ? (
        <ReactionsRow
          currentReaction={currentReaction}
          reactionsOnly={reactionsOnly}
          inset={isLaptop}
          onReact={(emoji) => {
            onReact(emoji);
            onClose();
          }}
          onMore={() => setPicking(true)}
          moreRef={moreRef}
        />
      ) : null}
      {items.length > 0 ? (
        <div data-menu-list="" className="flex min-h-0 flex-col overflow-y-auto overscroll-contain">
          {tiles.length === 0 ? null : isLaptop ? (
            tiles.map((item) => <MenuRow key={item.key} item={item} onRun={run} />)
          ) : (
            <div data-menu-tiles="" className="flex shrink-0 gap-2 py-2">
              {tiles.map((item) => (
                <MenuTile key={item.key} item={item} onRun={run} />
              ))}
            </div>
          )}
          {rest.map((entry, index) =>
            entry === MENU_DIVIDER ? (
              <div
                key={`divider-${index}`}
                aria-hidden="true"
                data-menu-divider=""
                className="shrink-0 border-t border-border"
              />
            ) : (
              <MenuRow key={entry.key} item={entry} onRun={run} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );

  // The smiley key: the one emoji drawer (ui/EmojiSheet) titled "Add reaction".
  const picker = active ? (
    <AddReactionSheet
      open={picking}
      onClose={() => setPicking(false)}
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
        style={{
          top: anchor.bottom - lift,
          left: menuAnchorX(anchor, mine, document.documentElement.clientWidth),
        }}
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
