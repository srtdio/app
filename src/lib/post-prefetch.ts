// Post detail opens from a press, not a mount. A press on a post card
// (pointerdown, touchstart) starts the page's code and its first-paint reads
// together: the PostDetailPage / pretty-link chunks, the post (getPost), its
// gallery, the viewer's role and the workspace members. The page's mount then
// joins those same reads instead of asking again, so the open costs the
// chunk and one round trip in parallel rather than chunk, then resolver,
// then reads.
//
// Never stale: a press's reads are joined only when the press became an
// open (confirmPostOpen, from the card's click) within POST_OPEN_FRESH_MS.
// A press that never opened (a drag to another column, a long-press menu, a
// scroll) is never served: the next mount drops it and reads again. Every
// mount consumes what it joined (the keys are dropped once it lands), so a
// later open of the same post always reads fresh. Signout and
// workspace-data-changed drop everything (session-read). RLS decides every
// read that actually runs.

import type { Client } from '@srtdio/rpc';
import { getPost, getPostGallery } from '@srtdio/posts';
import type { GalleryItem, PostDetail, Result } from '@srtdio/posts';
import { logger } from '@/lib/logger';
import { readSharedMemberRole } from '@/lib/member-role';
import { getPrefetchContext, type PrefetchContext } from '@/lib/route-data';
import { invalidateReads, readKey, sharedRead } from '@/lib/session-read';
import { supabase } from '@/lib/supabase';
import { ensureWorkspaceMembers } from '@/lib/workspace-members';

/** The Post detail page chunk (App.tsx's /posts/:postId lazy route uses this loader). */
export const loadPostDetail = () => import('@/components/pages/PostDetailPage');
/** The /p/:ref chunk (it renders PostDetailPage, whose chunk it pulls in alongside). */
export const loadPostRef = () => import('@/components/refs/PostRefResolver');
/** The Brief detail page chunk (App.tsx's /briefs/:briefId lazy route). */
export const loadBriefDetail = () => import('@/components/pages/BriefDetailPage');
/** The /b/:ref chunk. */
export const loadBriefRef = () => import('@/components/refs/BriefRefResolver');

/** How long a press's reads may be joined by the open that follows it. */
export const POST_OPEN_FRESH_MS = 5_000;

/**
 * pointerdown and touchstart fire together for one tap: a second press inside
 * this window joins the first one's reads instead of starting new ones. A
 * press after it (a fresh tap) always starts over, so nothing read before a
 * drag or a menu move is ever carried into the next open.
 */
export const PRESS_DEDUPE_MS = 250;

function openKey(userId: string, workspaceId: string, postId: string): string {
  return readKey(userId, workspaceId, `post-open:${postId}`);
}
function detailKey(userId: string, workspaceId: string, postId: string): string {
  return readKey(userId, workspaceId, `post-detail:${postId}|`);
}
function galleryKey(userId: string, workspaceId: string, postId: string): string {
  return readKey(userId, workspaceId, `post-gallery:${postId}|`);
}

const pressedAt = new Map<string, number>();
const confirmedAt = new Map<string, number>();

const isOk = (result: Result<unknown>): boolean => result.ok;

function readDetail(
  client: Client,
  key: string,
  postId: string,
): Promise<Result<PostDetail | null>> {
  return sharedRead(key, () => getPost(client, postId), { freshMs: POST_OPEN_FRESH_MS, isOk });
}
function readGallery(client: Client, key: string, postId: string): Promise<Result<GalleryItem[]>> {
  return sharedRead(key, () => getPostGallery(client, postId), {
    freshMs: POST_OPEN_FRESH_MS,
    isOk,
  });
}

/** What a press needs; injectable for tests. */
export interface PostOpenDeps {
  context: () => PrefetchContext | null;
  client: Client;
  loaders: readonly (() => Promise<unknown>)[];
  now: () => number;
}

const defaultDeps: PostOpenDeps = {
  context: getPrefetchContext,
  client: supabase,
  loaders: [loadPostRef, loadPostDetail],
  now: () => Date.now(),
};

function swallow(what: string): (err: unknown) => void {
  return (err: unknown) => logger.warn('post open prefetch failed', { what, error: String(err) });
}

/**
 * A press on a post card: start the page chunks and the first-paint reads.
 * Cheap, never throws, never paints. Nothing happens before the shell knows
 * the viewer and the workspace.
 */
export function prefetchPostOpen(postId: string, deps: PostOpenDeps = defaultDeps): void {
  try {
    const ctx = deps.context();
    if (ctx === null) return;
    for (const loader of deps.loaders) void loader().catch(swallow('chunk'));
    const { userId, workspaceId } = ctx;
    const open = openKey(userId, workspaceId, postId);
    const now = deps.now();
    const last = pressedAt.get(open);
    if (last === undefined || now - last > PRESS_DEDUPE_MS) {
      // A new press: whatever an earlier press read is dropped, never joined.
      invalidateReads(detailKey(userId, workspaceId, postId));
      invalidateReads(galleryKey(userId, workspaceId, postId));
      confirmedAt.delete(open);
      pressedAt.set(open, now);
    }
    void readDetail(deps.client, detailKey(userId, workspaceId, postId), postId).catch(
      swallow('post'),
    );
    void readGallery(deps.client, galleryKey(userId, workspaceId, postId), postId).catch(
      swallow('gallery'),
    );
    void readSharedMemberRole(deps.client, workspaceId, userId);
    ensureWorkspaceMembers(userId, workspaceId);
  } catch (err: unknown) {
    swallow('start')(err);
  }
}

/** The press became an open (the card's click): its reads may be joined by the mount. */
export function confirmPostOpen(postId: string, deps: PostOpenDeps = defaultDeps): void {
  const ctx = deps.context();
  if (ctx === null) return;
  confirmedAt.set(openKey(ctx.userId, ctx.workspaceId, postId), deps.now());
}

/**
 * Join a confirmed press's read for `key`, else read fresh; either way the key
 * is dropped once this lands, so the next open reads again (single use).
 */
function take<T>(open: string, key: string, read: () => Promise<T>, now: number): Promise<T> {
  const confirmed = confirmedAt.get(open);
  if (confirmed === undefined || now - confirmed > POST_OPEN_FRESH_MS) invalidateReads(key);
  const done = (): void => invalidateReads(key);
  const promise = read();
  promise.then(done, done);
  return promise;
}

/** The page mount's post read: joins a confirmed press, else reads. */
export function takePostDetail(
  client: Client,
  userId: string,
  workspaceId: string,
  postId: string,
  now: number = Date.now(),
): Promise<Result<PostDetail | null>> {
  const key = detailKey(userId, workspaceId, postId);
  return take(
    openKey(userId, workspaceId, postId),
    key,
    () => readDetail(client, key, postId),
    now,
  );
}

/** The page mount's gallery read: joins a confirmed press, else reads. */
export function takePostGallery(
  client: Client,
  userId: string,
  workspaceId: string,
  postId: string,
  now: number = Date.now(),
): Promise<Result<GalleryItem[]>> {
  const key = galleryKey(userId, workspaceId, postId);
  return take(
    openKey(userId, workspaceId, postId),
    key,
    () => readGallery(client, key, postId),
    now,
  );
}

/** Forget every press (tests). */
export function resetPostOpen(): void {
  pressedAt.clear();
  confirmedAt.clear();
}
