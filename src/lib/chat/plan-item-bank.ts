// Bank meets Plan on the item screen (PlanItemScreen) and the Bank list:
// the Buckets card's picks, the Who can see this card's copy, the item's More
// menu per kind, the idea shape the PR 816 Plan it and Show sheets take, and an
// Undo strip that outlives the screen (Move to bank and Delete close the
// screen at once; the write goes when the strip ends, never after Undo).
// Pure helpers plus one detached-undo runner; no reads before paint.

import {
  IconArchive,
  IconBank,
  IconCalendar,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconForward,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@/components/ui/icons';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import type { ToastOptions } from '@/components/ui/toast/types';
import { UNDO_MS } from '@/lib/undo';
import { undoFailureTitle } from '@/lib/use-undoable-action';
import { bankThumbOf, type BankIdea, type PlanItemRow } from '@/lib/chat/plans';

// ---------------------------------------------------------------------------
// Buckets card
// ---------------------------------------------------------------------------

export const BUCKETS_LABEL = 'Buckets';
export const ADD_BUCKET_LABEL = 'Add bucket';
export const NEW_BUCKET_PLACEHOLDER = 'Bucket name';
export const BUCKETS_SAVING = 'Saving…';
export const BUCKETS_SAVED = 'Saved';

/** The picked set with `id` toggled, in the order the options list them. Pure. */
export function toggleBucket(
  picked: readonly string[],
  id: string,
  order: readonly string[] = [],
): string[] {
  const next = picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
  if (order.length === 0) return next;
  const rank = (b: string): number => {
    const i = order.indexOf(b);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...next].sort((a, b) => rank(a) - rank(b));
}

/** The picked set plus a just-made bucket (no duplicate). Pure. */
export function withNewBucket(picked: readonly string[], id: string): string[] {
  return picked.includes(id) ? [...picked] : [...picked, id];
}

/** The save signal: Saving… while a write is in flight or queued, Saved after one landed. Pure. */
export function bucketSaveLabel(state: { saving: boolean; savedOnce: boolean }): string | null {
  if (state.saving) return BUCKETS_SAVING;
  return state.savedOnce ? BUCKETS_SAVED : null;
}

// ---------------------------------------------------------------------------
// Who can see this (bank ideas, agency only)
// ---------------------------------------------------------------------------

export const WHO_CAN_SEE_LABEL = 'Who can see this';
export const TEAM_ONLY_LINE = 'Approvers see it once it is in a shared plan, or when you show it.';
export const SHOW_TO_CLIENT_LABEL = 'Show to approvers';
export const HIDE_FROM_CLIENT_LABEL = 'Hide from approvers';
export const IDEA_HIDDEN_LABEL = 'Idea hidden';

/** "{names} see this idea and all its comments." (none named: "Approvers"). Pure. */
export function clientSeesLine(joinedNames: string): string {
  return `${joinedNames} see this idea and all its comments.`;
}

// ---------------------------------------------------------------------------
// The idea shape the PR 816 sheets take
// ---------------------------------------------------------------------------

/** A plan item as a Bank idea (the Plan it and Show sheets read title and comments). Pure. */
export function bankIdeaOf(item: PlanItemRow, commentCount: number): BankIdea {
  return {
    ...item,
    comment_count: commentCount,
    file_count: 0,
    thumb: bankThumbOf(undefined, item.description),
    format: null,
  };
}

/**
 * The Bank row a concept becomes when it moves to the bank (plan_item_to_bank
 * clears plan_id and target_date and keeps the plan it came from), for the
 * kept Bank page's own-write patch. Pure.
 */
export function bankIdeaMovedIn(
  item: PlanItemRow,
  fromPlanTitle: string | null,
  nowIso: string,
): BankIdea {
  return bankIdeaOf(
    {
      ...item,
      plan_id: null,
      target_date: null,
      came_from_plan_title: fromPlanTitle,
      archived_at: null,
      last_active_at: nowIso,
      updated_at: nowIso,
    } as PlanItemRow,
    0,
  );
}

/** The item with its flag overrides applied (what the server will hold). Pure. */
export interface IdeaFlags {
  show_to_client?: boolean;
  starred_at?: string | null;
  archived_at?: string | null;
}
export function withIdeaFlags(item: PlanItemRow, flags: IdeaFlags): PlanItemRow {
  return { ...item, ...flags };
}

// ---------------------------------------------------------------------------
// The item screen's More menu
// ---------------------------------------------------------------------------

export const MOVE_TO_BANK_ROW = 'Move to bank';
export const SEND_TO_CHAT_ROW = 'Send to chat';
export const PLAN_IT_ROW = 'Plan it';

/**
 * A planned concept's More menu (agency): Move to another day, Edit concept,
 * Send to chat, Move to bank, then Remove from plan (red, last). The base
 * rows come in as built (planConceptMenuItems and the remove row). Pure.
 */
export function plannedConceptMenu(
  base: readonly ActionMenuItem[],
  remove: ActionMenuItem,
  on: { onSendToChat: () => void; onMoveToBank: () => void },
): ActionMenuItem[] {
  return [
    ...base,
    { id: 'send-to-chat', label: SEND_TO_CHAT_ROW, icon: IconForward, onSelect: on.onSendToChat },
    { id: 'move-to-bank', label: MOVE_TO_BANK_ROW, icon: IconBank, onSelect: on.onMoveToBank },
    remove,
  ];
}

/** The bank idea menu's Edit row label. */
export const EDIT_IDEA_ROW = 'Edit idea';

/**
 * A bank idea's More menu (agency): Plan it, Edit idea, Send to chat, Show to
 * approvers or Hide from approvers, Star or Unstar, Archive or Unarchive, Delete
 * last. Pure.
 */
export function bankIdeaMenu(
  idea: Pick<PlanItemRow, 'show_to_client' | 'starred_at' | 'archived_at'>,
  on: {
    onPlanIt: () => void;
    onEdit: () => void;
    onSendToChat: () => void;
    onShow: () => void;
    onHide: () => void;
    onStar: (on: boolean) => void;
    onArchive: (on: boolean) => void;
    onDelete: () => void;
  },
): ActionMenuItem[] {
  const starred = idea.starred_at !== null && idea.starred_at !== undefined;
  const archived = idea.archived_at !== null && idea.archived_at !== undefined;
  return [
    { id: 'plan-it', label: PLAN_IT_ROW, icon: IconCalendar, onSelect: on.onPlanIt },
    { id: 'edit', label: EDIT_IDEA_ROW, icon: IconEdit, onSelect: on.onEdit },
    { id: 'send-to-chat', label: SEND_TO_CHAT_ROW, icon: IconForward, onSelect: on.onSendToChat },
    idea.show_to_client === true
      ? { id: 'hide', label: HIDE_FROM_CLIENT_LABEL, icon: IconEyeOff, onSelect: on.onHide }
      : { id: 'show', label: SHOW_TO_CLIENT_LABEL, icon: IconEye, onSelect: on.onShow },
    starred
      ? { id: 'unstar', label: 'Unstar', icon: IconStar, onSelect: () => on.onStar(false) }
      : { id: 'star', label: 'Star', icon: IconStarFilled, onSelect: () => on.onStar(true) },
    {
      id: 'archive',
      label: archived ? 'Unarchive' : 'Archive',
      icon: IconArchive,
      onSelect: () => on.onArchive(!archived),
    },
    { id: 'delete', label: 'Delete', icon: IconTrash, tone: 'danger', onSelect: on.onDelete },
  ];
}

// ---------------------------------------------------------------------------
// An Undo strip that outlives the screen
// ---------------------------------------------------------------------------

export interface DetachedUndo {
  label: string;
  /** The write; runs once when the strip ends (or the page hides), never after Undo. */
  commit: () => Promise<void>;
  /** Put the optimistic state back (Undo, or a failed commit). */
  revert?: () => void;
  /** The failure toast's title; default undoFailureTitle(label). */
  failure?: string;
}

type ShowToast = (options: ToastOptions) => string;

/**
 * Show the Undo strip (UNDO_MS) and commit when it ends. Unlike
 * useUndoableAction it is held by the toast provider, not the screen, so the
 * screen may close at once (Move to bank, Delete) without the write going
 * early. A hidden page commits at once so nothing is lost.
 */
export function runDetachedUndo(show: ShowToast, action: DetachedUndo): void {
  let settled = false;
  const commit = (): void => {
    if (settled) return;
    settled = true;
    window.removeEventListener('pagehide', commit);
    void action.commit().catch((error: unknown) => {
      action.revert?.();
      show({ title: action.failure ?? undoFailureTitle(action.label, error), tone: 'error' });
    });
  };
  window.addEventListener('pagehide', commit);
  show({
    title: action.label,
    kind: 'undo',
    durationMs: UNDO_MS,
    action: {
      label: 'Undo',
      onPress: () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('pagehide', commit);
        action.revert?.();
      },
    },
    onExpire: commit,
  });
}
