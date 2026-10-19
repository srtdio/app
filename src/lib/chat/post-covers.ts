// Post covers for the chat post lists (Share a post / Pick a post rows, the
// status drop-down, the composer chips): each post's first photo or video,
// kept in one session store so a list opened twice, or warmed before it
// opens, paints its pictures at once. Reads are batched: one asset_attachments
// query per set of ids not yet known (never one per row), and ids already in
// flight are never asked for twice. A cover older than COVER_TTL_MS is shown
// as is and read again in the background, so a changed first picture catches
// up without the row ever going blank.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { readPostCovers, type CardFirstMedia } from '../../../packages/posts/src/reads';

/** A post's cover: its first photo or video, null for none, undefined while unknown. */
export type CoverLookup = (postId: string) => CardFirstMedia | null | undefined;

export const COVER_TTL_MS = 5 * 60_000;

export interface CoverEntry {
  cover: CardFirstMedia | null;
  at: number;
}

const entries = new Map<string, CoverEntry>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function keyOf(workspaceId: string, postId: string): string {
  return `${workspaceId}:${postId}`;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return version;
}

/** The stored cover for a post (stale or not), undefined when never read. */
export function coverFor(workspaceId: string, postId: string): CardFirstMedia | null | undefined {
  return entries.get(keyOf(workspaceId, postId))?.cover;
}

/** The ids a read should ask for: unknown or stale, and not already in flight. Pure. */
export function idsToRead(
  ids: readonly string[],
  known: (postId: string) => CoverEntry | undefined,
  busy: (postId: string) => boolean,
  now: number,
): string[] {
  return [...new Set(ids)].filter((id) => {
    if (busy(id)) return false;
    const entry = known(id);
    return entry === undefined || now - entry.at >= COVER_TTL_MS;
  });
}

/**
 * Read the covers this store does not have (or has stale) for `ids`, in one
 * query. A failed read leaves those ids unknown so the next request retries.
 */
export async function requestPostCovers(
  client: Client,
  workspaceId: string,
  ids: readonly string[],
): Promise<void> {
  const need = idsToRead(
    ids,
    (id) => entries.get(keyOf(workspaceId, id)),
    (id) => inflight.has(keyOf(workspaceId, id)),
    Date.now(),
  );
  if (need.length === 0) return;
  for (const id of need) inflight.add(keyOf(workspaceId, id));
  try {
    const result = await readPostCovers(client, need);
    if (!result.ok) return;
    const at = Date.now();
    for (const [id, cover] of result.data) entries.set(keyOf(workspaceId, id), { cover, at });
    notify();
  } catch {
    // A transport failure leaves the ids unknown; the next request retries.
  } finally {
    for (const id of need) inflight.delete(keyOf(workspaceId, id));
  }
}

/**
 * The covers for the posts a list shows. Asks the store for any it lacks on
 * mount and whenever the id set changes; re-renders when covers land.
 */
export function usePostCovers(ids: readonly string[]): CoverLookup {
  const { workspaceId } = useWorkspace();
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (workspaceId === null || key === '') return;
    void requestPostCovers(supabase, workspaceId, key.split(','));
  }, [workspaceId, key]);
  return useCallback<CoverLookup>(
    (postId) => (workspaceId === null ? null : coverFor(workspaceId, postId)),
    // current re-derives the lookup so consumers re-render with new covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, current],
  );
}
