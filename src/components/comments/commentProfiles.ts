// Batched id -> display-name/avatar resolver for the post / brief comment panel.
//
// Mirrors chat-reads.ts's users read (select id, display_name, avatar_url from
// users where id in (...)) without importing it, so the comment panel never
// pulls in the chat read surface. The panel collects every author id plus every
// @[uuid] mention id and resolves them in ONE IN-clause read (no N+1). Read-only
// under RLS; a caller supplies no trust. A user who no longer resolves to a
// member is simply absent from the map, and the UI falls back to the app's
// "(ex-member)" convention rather than the helper ever throwing.

import type { Client } from '@srtdio/comments';

/** A user's display slice, the only fields the comment panel renders. */
export interface CommentProfile {
  displayName: string;
  avatarUrl: string | null;
}

/** Shown for any author or @mention id that no longer resolves to a member. */
export const EX_MEMBER_LABEL = '(ex-member)';

/**
 * Resolve display info for a set of user ids. Ids are de-duplicated and empties
 * dropped; an empty set short-circuits to an empty map with no round-trip. A
 * transport error resolves to whatever was read (empty on total failure) so the
 * panel degrades to "(ex-member)" labels instead of throwing.
 */
export async function fetchCommentProfiles(
  client: Client,
  userIds: readonly string[],
): Promise<Map<string, CommentProfile>> {
  const ids = Array.from(new Set(userIds.filter((id) => id !== '')));
  const profiles = new Map<string, CommentProfile>();
  if (ids.length === 0) return profiles;

  const { data, error } = await client
    .from('users')
    .select('id, display_name, avatar_url')
    .in('id', ids);
  if (error || data === null) return profiles;

  for (const row of data) {
    profiles.set(row.id, { displayName: row.display_name, avatarUrl: row.avatar_url });
  }
  return profiles;
}

/** The display name for one id, or null when it no longer resolves to a member. */
export function resolveName(
  profiles: ReadonlyMap<string, CommentProfile>,
  userId: string,
): string | null {
  return profiles.get(userId)?.displayName ?? null;
}
