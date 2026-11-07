// Delete for me, the optimistic flow: the messages leave this person's view at
// once (hideLocal) while the "Deleted for you" toast shows its Undo; the
// write (chat_messages_hide) runs only when the 4 s window ends
// (useUndoableAction). Undo shows them again in place; a failed write shows
// them again and the shared failure toast says so.

import { useCallback } from 'react';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { errorText } from '@/lib/error-copy';
import { generateTraceId } from '@/lib/trace';
import { hideLocal, hideMessages, unhideLocal } from '@/lib/chat/hides';

/** One message to hide, with the chat it is in. */
export interface HideItem {
  messageId: string;
  channelId: string;
}

/** The Undo toast's title: "Deleted for you" or "N deleted for you". Pure. */
export function deletedForYouLabel(count: number): string {
  return count === 1 ? 'Deleted for you' : `${count} deleted for you`;
}

/** The failure toast's title when the write fails. Pure. */
export function deleteForMeFailure(count: number, error: unknown): string {
  return errorText(count === 1 ? 'delete the message' : `delete ${count} messages`, error);
}

/**
 * Returns run(items): hides them now and writes once the Undo window ends.
 * A no-op without a user or workspace (nothing to write under).
 */
export function useDeleteForMe(input: {
  userId: string | null | undefined;
  workspaceId: string | null | undefined;
}): (items: readonly HideItem[]) => void {
  const undoable = useUndoableAction();
  const { userId, workspaceId } = input;
  const run = undoable.run;
  return useCallback(
    (items: readonly HideItem[]): void => {
      if (userId == null || workspaceId == null || items.length === 0) return;
      const ids = items.map((item) => item.messageId);
      const traceId = generateTraceId();
      hideLocal(workspaceId, items);
      run({
        label: deletedForYouLabel(items.length),
        failure: (error) => deleteForMeFailure(items.length, error),
        commit: () => hideMessages({ userId, workspaceId, items, traceId }),
        revert: () => unhideLocal(workspaceId, ids),
      });
    },
    [userId, workspaceId, run],
  );
}
