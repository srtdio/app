// The Pipeline's posts read, shared within this tab session (in memory only,
// src/lib/session-read.ts). A nav press on Pipeline starts it
// (prefetchPipelineData) and the page's mount joins the same request. Coming
// back to the tab inside the freshness window paints the posts this session
// already read, with no request; past the window they are absent, so the page
// shows its skeleton and reads again. Older posts are never painted.
//
// The kept read is dropped the moment anything says the posts may differ:
// a post changed (POST_CHANGED_EVENT, the chat post sheet's writes), a plan
// changed (PLAN_CHANGED_EVENT: plan edits move posts' dates), the workspace's
// rows changed (WORKSPACE_DATA_CHANGED_EVENT, dropped by session-read itself),
// sign-out, and the Pipeline's own writes and reloads (dropPipelinePosts).

import { listPosts, type Client, type PipelinePost } from '@srtdio/posts';
import type { Result } from '@srtdio/rpc';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { readSharedMemberRole } from '@/lib/member-role';
import type { PrefetchContext } from '@/lib/prefetch-context';
import { invalidateReads, peekRead, readKey, sharedRead } from '@/lib/session-read';

/** The board reads the newest posts up to this many (listPosts caps it too). */
export const PIPELINE_POSTS_LIMIT = 500;

const WHAT = 'pipeline-posts';

/** The session key of the Pipeline's posts for a user and workspace. */
export function pipelinePostsKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, WHAT);
}

// Every key this module started, so a change event drops them all whatever
// user and workspace they belong to (the session reads are keyed user first).
const started = new Set<string>();

/**
 * The board's posts, joined with a read already running or settled inside the
 * window. `read` is the page's reader (the page passes its own import, so its
 * tests can stand in for the network); the key, not the reader, is what joins.
 * A failed read is never kept.
 */
export function readPipelinePosts(
  client: Client,
  userId: string,
  workspaceId: string,
  read: typeof listPosts = listPosts,
): Promise<Result<PipelinePost[]>> {
  const key = pipelinePostsKey(userId, workspaceId);
  started.add(key);
  return sharedRead(key, () => read(client, { workspaceId, limit: PIPELINE_POSTS_LIMIT }), {
    isOk: (result) => result.ok,
  });
}

/**
 * The posts this session read for the board inside the freshness window, or
 * undefined (never read, still running, failed, dropped or older than the
 * window). Never reads. What the page paints on a tab return.
 */
export function peekPipelinePosts(
  userId: string,
  workspaceId: string,
  nowMs: number = Date.now(),
): PipelinePost[] | undefined {
  const kept = peekRead<Result<PipelinePost[]>>(pipelinePostsKey(userId, workspaceId), nowMs);
  return kept !== undefined && kept.ok ? kept.data : undefined;
}

/** Forget the board's kept read (a write or a reload on the board). */
export function dropPipelinePosts(userId: string, workspaceId: string): void {
  invalidateReads(pipelinePostsKey(userId, workspaceId));
}

/** Forget every kept board read (a post or plan changed somewhere). */
export function dropAllPipelinePosts(): void {
  for (const key of started) invalidateReads(key);
  started.clear();
}

/**
 * Nav-press starter (src/lib/route-data.ts): the board's posts and the
 * viewer's role, so they run while the chunk loads and the tap lands. A fresh
 * kept read is joined (no request). Paints nothing; never throws. The client
 * loads lazily so this module stays cheap to import.
 */
export function prefetchPipelineData(ctx: PrefetchContext): Promise<void> {
  return import('@/lib/supabase').then(
    ({ supabase }) => {
      const swallow = (): void => {};
      readPipelinePosts(supabase, ctx.userId, ctx.workspaceId).catch(swallow);
      readSharedMemberRole(supabase, ctx.workspaceId, ctx.userId).catch(swallow);
    },
    () => undefined,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener(POST_CHANGED_EVENT, dropAllPipelinePosts);
  window.addEventListener(PLAN_CHANGED_EVENT, dropAllPipelinePosts);
}
