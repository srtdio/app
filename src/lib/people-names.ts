// One batched name read for the people surfaces (Activity, the Activity toast,
// Comments). Ids not known yet resolve with one users .in() read and one
// workspace_members .in() read in the same pass (readMentionProfiles), and the
// answer lands in the shared registry in mentions.ts, so every surface renders
// the same name: full name for a current member, "Former member" for anyone a
// successful read found without a current membership. No placeholders, no N+1.

import type { Client } from '@srtdio/rpc';
import { READ_TIMEOUT_MS, readMentionProfiles } from '@/lib/chat-reads';
import { rememberMentionRead, unresolvedPeopleIds } from '@/lib/chat/mentions';
import { logger } from '@/lib/logger';

export { FORMER_MEMBER, personAvatar, personMentionLabel, personName } from '@/lib/chat/mentions';

/** The batched read: users + workspace_members for these ids, membership marked. */
export type PeopleRead = (userIds: string[]) => ReturnType<typeof readMentionProfiles>;

/**
 * Resolve every id this workspace does not know yet, in one batched read.
 * Returns false only when the read failed (the ids stay unresolved and the next
 * call retries them); true when everything is now known or nothing was needed.
 */
export async function resolvePeople(
  client: Client,
  workspaceId: string | null,
  ids: Iterable<string>,
  read: PeopleRead = (userIds) =>
    readMentionProfiles(client, {
      workspaceId: workspaceId ?? '',
      userIds,
      timeoutMs: READ_TIMEOUT_MS,
    }),
): Promise<boolean> {
  const need = unresolvedPeopleIds(workspaceId, ids);
  if (workspaceId === null || need.length === 0) return true;
  const res = await read(need);
  if (!res.ok) {
    logger.warn('people: name read failed', { error: res.error.message });
    return false;
  }
  rememberMentionRead(workspaceId, need, res.data);
  return true;
}
