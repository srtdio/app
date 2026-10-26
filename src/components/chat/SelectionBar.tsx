// Selection mode's two bars. The header bar replaces the thread header: "N
// selected" and a 44x44 Cancel. The bottom bar replaces the composer: Forward
// (any recorded message), Star or Unstar (Unstar only when every selected
// message is already starred; one write for the batch) and Delete (own,
// unmarked, inside 30 minutes). When
// Delete cannot apply it stays visible but disabled, with one line saying why.
// Delete opens the confirm dialog; a failure shows the mapped copy as a toast
// (never raw proc text) and the selection is kept (the caller only clears it
// on success). The bottom bar keeps clear of the safe-area inset. Design
// tokens only, so light and dark stay at parity.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ICON_SIZE, IconForward, IconStar, IconTrash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { bottomAnchorProps } from '@/lib/bottom-inset';
import { DELETE_BLOCK_COPY, type DeleteBlock } from '@/lib/chat/forward';
import { deleteNotesConfirmCopy, type DeleteConfirmCopy } from '@/lib/chat/delete-flow';
import { STAR_LABEL, UNSTAR_LABEL } from '@/lib/chat/stars';
import {
  HEADER_NAME_TYPE,
  SELECTION_REASON_TYPE,
  sized,
  type ChatLayout,
} from '@/components/chat/chat-type';

/** The selection header's count line. */
export function selectedCountLabel(count: number): string {
  return `${count} selected`;
}

/**
 * The header while selecting: the count and Cancel (44x44), in place of the
 * thread header. Zero selected stays here until Cancel. Hook-free.
 */
export function SelectionHeader(props: {
  count: number;
  onCancel: () => void;
  layout: ChatLayout;
}): ReactElement {
  return (
    <>
      <span
        data-selection-count=""
        aria-live="polite"
        className={cn('min-w-0 flex-1 truncate text-fg', sized(HEADER_NAME_TYPE, props.layout))}
      >
        {selectedCountLabel(props.count)}
      </span>
      <Button
        type="button"
        variant="link"
        data-selection-cancel=""
        onClick={props.onCancel}
        className="min-w-[44px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Cancel
      </Button>
    </>
  );
}

/** The selection bar's Star action: which way it goes, and the run. */
interface SelectionStar {
  /** 'unstar' when every selected message is already starred. */
  action: 'star' | 'unstar';
  onRun: () => void;
}

/** The bottom bar's frame: a top border on the panel, clear of the safe-area inset. */
const SELECTION_BAR_CLASS =
  'flex shrink-0 flex-col gap-1 border-t border-border bg-panel px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3';

/**
 * The remove-only bottom bar (chat info Media and Files select mode): the same
 * frame as SelectionBarView with one danger Remove, disabled only while
 * nothing is selected. Hook-free.
 */
export function RemoveSelectionBarView(props: {
  count: number;
  /** The button's copy (REMOVE_LABEL). */
  label: string;
  onRemove: () => void;
  barTestId?: string | undefined;
  removeTestId?: string | undefined;
}): ReactElement {
  return (
    <div
      data-selection-bar=""
      data-testid={props.barTestId}
      // A bottom bar: the Undo strip stacks above it.
      {...bottomAnchorProps}
      className={SELECTION_BAR_CLASS}
    >
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="danger"
          data-selection-remove=""
          data-testid={props.removeTestId}
          disabled={props.count === 0}
          onClick={props.onRemove}
        >
          {props.label}
        </Button>
      </div>
    </div>
  );
}

/**
 * The bottom bar's view: Forward, Star or Unstar, then Delete, with the reason line under the
 * pair when Delete is blocked. Hook-free so the tests call it directly.
 */
export function SelectionBarView(props: {
  count: number;
  /** Why Delete cannot apply (the reason line), or null. */
  block: DeleteBlock | null;
  /** False disables Delete (a block, or nothing selected). */
  canDelete: boolean;
  /** Opens the forward picker; absent hides Forward. */
  onForward?: (() => void) | undefined;
  /** Star or Unstar the selection; absent hides it. */
  star?: SelectionStar | undefined;
  /** Opens the delete confirm. */
  onDeleteTap: () => void;
}): ReactElement {
  const star = props.star;
  return (
    <div
      data-selection-bar=""
      // A bottom bar in place of the composer: the Undo strip stacks above it.
      {...bottomAnchorProps}
      className={SELECTION_BAR_CLASS}
    >
      <div className="flex items-center justify-between gap-2">
        {props.onForward !== undefined ? (
          <Button
            variant="ghost"
            data-selection-forward=""
            disabled={props.count === 0}
            onClick={props.onForward}
          >
            <IconForward size={ICON_SIZE.inline} />
            Forward
          </Button>
        ) : (
          <span />
        )}
        {star !== undefined ? (
          <Button
            variant="ghost"
            data-selection-star={star.action}
            disabled={props.count === 0}
            onClick={star.onRun}
          >
            <IconStar size={ICON_SIZE.inline} />
            {star.action === 'unstar' ? UNSTAR_LABEL : STAR_LABEL}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          data-selection-delete=""
          aria-describedby={props.block !== null ? 'selection-delete-reason' : undefined}
          className="text-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50"
          disabled={!props.canDelete}
          onClick={props.onDeleteTap}
        >
          <IconTrash size={ICON_SIZE.inline} />
          Delete
        </Button>
      </div>
      {props.block !== null ? (
        <p
          id="selection-delete-reason"
          data-selection-reason={props.block}
          className={cn('text-right text-fg-3', SELECTION_REASON_TYPE)}
        >
          {DELETE_BLOCK_COPY[props.block]}
        </p>
      ) : null}
    </div>
  );
}

export function SelectionBar(props: {
  count: number;
  /** Why Delete cannot apply (see deleteSelectionBlock), or null. */
  block: DeleteBlock | null;
  /** False when Delete cannot apply to the selection (or nothing is selected). */
  canDelete: boolean;
  /** Opens the forward picker for the selection; absent hides Forward. */
  onForward?: (() => void) | undefined;
  /** Star or Unstar the selection; absent hides it. */
  star?: SelectionStar | undefined;
  /** The files confirm (deleteConfirmCopy), or null for today's text-only copy. */
  confirmCopy?: DeleteConfirmCopy | null;
  /** Personal notes: the notes copy, never "for everyone". */
  notes?: boolean;
  /** Runs the delete; resolves ok (with a toast when files went), or the user copy to toast. */
  onDelete: () => Promise<{ ok: true; toast?: string } | { ok: false; message: string }>;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const result = await props.onDelete();
    setBusy(false);
    setConfirming(false);
    if (!result.ok) toast.show({ title: result.message });
    else if (result.toast !== undefined) toast.show({ title: result.toast });
  }

  return (
    <>
      <SelectionBarView
        count={props.count}
        block={props.block}
        canDelete={props.canDelete}
        onForward={props.onForward}
        star={props.star}
        onDeleteTap={() => setConfirming(true)}
      />
      {deleteMessagesConfirm({
        open: confirming,
        count: props.count,
        copy: props.confirmCopy ?? null,
        notes: props.notes === true,
        busy,
        onCancel: () => setConfirming(false),
        onConfirm: () => void confirm(),
      })}
    </>
  );
}

/** Confirm title for the selected messages. */
function deleteMessagesTitle(count: number): string {
  return `Delete ${count} ${count === 1 ? 'message' : 'messages'}?`;
}

/** Confirm body: the delete is for everyone and final. */
const DELETE_MESSAGES_MESSAGE =
  'They will be removed from this chat for everyone. This cannot be undone.';

/**
 * The delete-selected confirm, or null when closed. Hook-free so the confirm and
 * cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteMessagesConfirm(props: {
  open: boolean;
  count: number;
  /** The files confirm; null (or absent) keeps the text-only copy. */
  copy?: DeleteConfirmCopy | null;
  /** Personal notes: the notes copy wins (nothing there is "for everyone"). */
  notes?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (!props.open) return null;
  const copy = props.notes === true ? deleteNotesConfirmCopy(props.count) : (props.copy ?? null);
  return (
    <ConfirmDialog
      title={copy?.title ?? deleteMessagesTitle(props.count)}
      message={copy?.message ?? DELETE_MESSAGES_MESSAGE}
      confirmLabel={copy?.confirmLabel ?? 'Delete'}
      busyLabel="Deleting"
      destructive
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

/** The single-message delete confirm (the action menu's Delete). */
const DELETE_ONE_TITLE = 'Delete message?';
const DELETE_ONE_MESSAGE = 'It is removed for everyone in this chat.';
const DELETE_ONE_CONFIRM = 'Delete for everyone';

/**
 * The single-message delete confirm, or null when closed. Hook-free so the
 * confirm and cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteOneConfirm(props: {
  open: boolean;
  busy: boolean;
  /** The files confirm (deleteConfirmCopy); null (or absent) keeps the text copy. */
  copy?: DeleteConfirmCopy | null;
  /** Personal notes: "Delete note?", never "for everyone". */
  notes?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (!props.open) return null;
  const copy = props.notes === true ? deleteNotesConfirmCopy(1) : (props.copy ?? null);
  return (
    <ConfirmDialog
      title={copy?.title ?? DELETE_ONE_TITLE}
      message={copy?.message ?? DELETE_ONE_MESSAGE}
      confirmLabel={copy?.confirmLabel ?? DELETE_ONE_CONFIRM}
      busyLabel="Deleting"
      destructive
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
