// Batched id -> display-name/avatar resolver for the post / brief comment panel.
//
// Mirrors chat-reads.ts's users read (select id, display_name, avatar_url from
// users where id in (...)) without importing it, so the comment panel never
// pulls in the chat read surface. The panel collects every author id plus every
// @[uuid] mention id and resolves them in ONE IN-clause read (no N+1). Read-only
// under RLS; a caller supplies no trust. A user who no longer resolves to a
// member is simply absent from the map, and the UI falls back to the shared
// name helper (src/lib/people-names.ts) rather than the helper ever throwing.

import type { Client } from '@srtdio/comments';

/** A user's display slice, the only fields the comment panel renders. */
export interface CommentProfile {
  displayName: string;
  avatarUrl: string | null;
  /** The @username a mention reads as; null when the person has none. */
  username?: string | null;
}

/**
 * Resolve display info for a set of user ids. Ids are de-duplicated and empties
 * dropped; an empty set short-circuits to an empty map with no round-trip. A
 * transport error resolves to whatever was read (empty on total failure) so the
 * panel degrades to the shared name helper's labels instead of throwing.
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
    .select('id, display_name, avatar_url, username')
    .in('id', ids);
  if (error || data === null) return profiles;

  for (const row of data) {
    profiles.set(row.id, {
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      username: row.username ?? null,
    });
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

/** What a mention of this id reads as after the "@": @username, else the name; null when gone. */
export function resolveMentionHandle(
  profiles: ReadonlyMap<string, CommentProfile>,
  userId: string,
): string | null {
  const profile = profiles.get(userId);
  if (profile === undefined) return null;
  return profile.username !== undefined && profile.username !== null && profile.username !== ''
    ? profile.username
    : profile.displayName;
}

/** The slice of a current member the panel reads (a MentionCandidate). */
export interface MemberProfileSource {
  id: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
}

/**
 * The author lookup the panel renders from, held data only (no read):
 * current members (the mention candidates) first, then the panel's own map
 * (former members, mentions of people gone). A member whose profile has not
 * loaded (empty name) falls through to the map.
 */
export function authorProfiles(
  members: readonly MemberProfileSource[],
  profiles: ReadonlyMap<string, CommentProfile>,
): Map<string, CommentProfile> {
  const out = new Map(profiles);
  for (const member of members) {
    if (member.name === '') continue;
    out.set(member.id, {
      displayName: member.name,
      avatarUrl: member.avatarUrl,
      username: member.username,
    });
  }
  return out;
}

/** Ids among `ids` that `profiles` lacks and `lookup` already knows (registry backfill). */
export function backfillProfiles(
  ids: Iterable<string>,
  profiles: ReadonlyMap<string, CommentProfile>,
  lookup: (id: string) => CommentProfile | undefined,
): Map<string, CommentProfile> {
  const filled = new Map<string, CommentProfile>();
  for (const id of ids) {
    if (profiles.has(id) || filled.has(id)) continue;
    const profile = lookup(id);
    if (profile !== undefined) filled.set(id, profile);
  }
  return filled;
}
