// The one name a chat shows everywhere: the chat list, the thread header,
// search, the New chat sheet and the forward picker.

import type { ChannelSummary } from '@/lib/chat-reads';
import { NOTES_TITLE } from '@/lib/chat/notes';

/** The fallback when a group's row has no name yet. */
const GROUP_NAME_FALLBACK = 'Group';

/** The fallback when a direct message's other person has no profile row. */
const DM_NAME_FALLBACK = 'Direct message';

/**
 * A chat's display name. Pure.
 * - Direct message: the other person's full name.
 * - Group: the group's name.
 * - Personal notes: "Personal notes".
 */
export function chatDisplayName(chat: Pick<ChannelSummary, 'channelType' | 'title'>): string {
  if (chat.channelType === 'notes') return NOTES_TITLE;
  const name = chat.title.trim();
  if (name !== '') return name;
  return chat.channelType === 'group' ? GROUP_NAME_FALLBACK : DM_NAME_FALLBACK;
}
