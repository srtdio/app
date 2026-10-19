// "Delete chat" for the caller only, from the chat list. Pure of React and of
// Supabase (the proc call is injected) so the run order is unit-tested: chats
// are cleared one at a time in the order given, the first failure stops the run
// and the remaining chats are left untouched. Copy for the confirm and the
// failure toast lives here too so the list and its tests share one source.

import type { WriteResult } from '@/lib/chat/record';

/** Confirm body: the delete is local to the caller and undone by a new message. */
export const DELETE_CHATS_BODY =
  'Removes the chat and its messages for you only. Other members keep their copy. It comes back if someone sends a new message.';

/** Confirm title for one or several chats. */
export function deleteChatsTitle(count: number): string {
  return count === 1 ? 'Delete this chat?' : `Delete ${count} chats?`;
}

/** Toast when a chat could not be hidden (the list's action reads "Hide"). */
export function deleteChatFailedMessage(title: string): string {
  return `Couldn't hide ${title}.`;
}

export type ClearRunResult<T> = { ok: true } | { ok: false; failed: T; message: string };

/**
 * Clear chats sequentially. `onCleared` runs after each accepted clear (the
 * caller applies the local effect then); the first failing chat stops the run.
 */
export async function runClearChannels<T extends { channelId: string }>(deps: {
  channels: readonly T[];
  clear: (channelId: string) => Promise<WriteResult>;
  onCleared: (channel: T) => void;
}): Promise<ClearRunResult<T>> {
  for (const channel of deps.channels) {
    const result = await deps.clear(channel.channelId);
    if (!result.ok) return { ok: false, failed: channel, message: result.message };
    deps.onCleared(channel);
  }
  return { ok: true };
}
