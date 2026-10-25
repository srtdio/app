// The paging floor of the caller's inbox: the created_at of their oldest
// inbox_entries row in a workspace. inbox_entries is RANGE (created_at)
// partitioned by month, so list reads walk partition-bounded windows
// (src/lib/chat/bounded-window.ts) and need this floor to know when the
// first entry has been reached: the inbox is permanent, so paging back
// always ends at the very first entry, never before it.

import type { Client, Result } from '@srtdio/rpc';

/**
 * The oldest inbox row the caller can read in a workspace (RLS scopes it to
 * their own rows; deleted rows included, a floor only needs to be no later
 * than the oldest live row), or null when the inbox is empty. One ordered
 * LIMIT 1 read: one index probe per partition. Never throws.
 */
export async function readInboxOldest(
  client: Client,
  workspaceId: string,
): Promise<Result<string | null>> {
  try {
    const res = await client
      .from('inbox_entries')
      .select('created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (res.error) {
      return {
        ok: false,
        error: { code: 'unknown', message: `readInboxOldest: ${res.error.message}` },
      };
    }
    const first = (res.data ?? [])[0];
    return { ok: true, data: first !== undefined ? first.created_at : null };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}
