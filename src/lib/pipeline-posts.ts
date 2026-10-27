// The Pipeline's posts read, shared within this tab session (in memory only,
// src/lib/session-read.ts). A nav press on Pipeline starts it
// (prefetchPipelineData) and the page's mount joins the same request. Coming
// back to the tab paints the posts this session last read or wrote
// (keptPipelinePosts), at any age, then the page refreshes them quietly: inside
// the freshness window the refresh joins the kept read with no request.
//
// The kept posts are marked stale (never deleted) the moment anything says
// they may differ, so the next visit still paints them and reads again: a post
// changed (POST_CHANGED_EVENT, the chat post sheet's writes), a plan changed
// (PLAN_CHANGED_EVENT: plan edits move posts' dates), the workspace's rows
// changed (WORKSPACE_DATA_CHANGED_EVENT, marked by session-read itself), and
// the Pipeline's reloads and leaving for a post (stalePipelinePosts). The
// board's own writes replace them (primePipelinePosts). Sign-out deletes them.

import { mark } from '@/lib/perf-marks';
import { listPosts, type Client, type PipelinePost } from '@srtdio/posts';
import type { Result } from '@srtdio/rpc';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { readSharedMemberRole } from '@/lib/member-role';
import type { PrefetchContext } from '@/lib/prefetch-context';
import { invalidateReads, peekKept, primeRead, readKey, sharedRead } from '@/lib/session-read';
import { generateTraceId } from '@/lib/trace';

/** The board reads the newest posts up to this many (listPosts caps it too). */
export const PIPELINE_POSTS_LIMIT = 500;

const WHAT = 'pipeline-posts';

/** The session key of the Pipeline's posts for a user and workspace. */
export function pipelinePostsKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, WHAT);
}

// Every key this module read or wrote, so a change event marks them all stale
// whatever user and workspace they belong to (the session reads are keyed user
// first). Kept for the session: a kept key stays until sign-out.
const started = new Set<string>();

/**
 * The board's posts, joined with a read already running or settled inside the
 * window. `read` is the page's reader (the page passes its own import, so its
 * tests can stand in for the network); the key, not the reader, is what joins.
 * `traceId` is the load's one trace id, sent as posts_list's p_trace_id (a
 * fresh uuid_v7 when absent, e.g. the nav-press prefetch); a joined read keeps
 * the trace of the load that started it. A failed read is never kept.
 */
export function readPipelinePosts(
  client: Client,
  userId: string,
  workspaceId: string,
  read: typeof listPosts = listPosts,
  traceId?: string,
): Promise<Result<PipelinePost[]>> {
  const key = pipelinePostsKey(userId, workspaceId);
  started.add(key);
  return sharedRead(
    key,
    () =>
      read(client, {
        workspaceId,
        limit: PIPELINE_POSTS_LIMIT,
        traceId: traceId ?? generateTraceId(),
      }),
    { isOk: (result) => result.ok },
  );
}

/**
 * The posts this session last read or wrote for the board, at any age (stale
 * or not, also while a newer read runs), or undefined (never read ok). Never
 * reads. What the page paints on a tab return.
 */
export function keptPipelinePosts(userId: string, workspaceId: string): PipelinePost[] | undefined {
  const kept = peekKept<Result<PipelinePost[]>>(pipelinePostsKey(userId, workspaceId));
  return kept !== undefined && kept.ok ? kept.data : undefined;
}

/** Keep the board's posts after its own write (a move, its Undo), as a fresh read. */
export function primePipelinePosts(
  userId: string,
  workspaceId: string,
  posts: PipelinePost[],
): void {
  const key = pipelinePostsKey(userId, workspaceId);
  started.add(key);
  primeRead<Result<PipelinePost[]>>(key, { ok: true, data: posts });
}

/** Mark the board's kept posts stale (a reload, leaving for a post): the next read asks again. */
export function stalePipelinePosts(userId: string, workspaceId: string): void {
  invalidateReads(pipelinePostsKey(userId, workspaceId));
}

/** Mark every kept board read stale (a post or plan changed somewhere). */
export function staleAllPipelinePosts(): void {
  for (const key of started) invalidateReads(key);
}

/**
 * Nav-press starter (src/lib/route-data.ts): the board's posts and the
 * viewer's role, so they run while the chunk loads and the tap lands. A fresh
 * kept read is joined (no request). Paints nothing; never throws. The client
 * loads lazily so this module stays cheap to import.
 */
export function prefetchPipelineData(ctx: PrefetchContext): Promise<void> {
  mark('pipeline:prefetch');
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
  window.addEventListener(POST_CHANGED_EVENT, staleAllPipelinePosts);
  window.addEventListener(PLAN_CHANGED_EVENT, staleAllPipelinePosts);
}
