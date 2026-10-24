// The post chip a message carries when it replies to a card message outside the
// card's thread, plus the thread-level batch that feeds every chip, the thread
// chips and titles, and the About bar.
// The batch is ONE readPostCards call per distinct set of new post ids per
// thread (memoised; it only grows when new ids appear), never one per chip. A
// chip paints only once its post is in the batch, so it never swaps after first
// paint; a post the viewer's RLS hides (or a failed read) resolves to null and
// the message keeps its plain quote. Tokens only; the own bubble's overrides
// (OWN_BUBBLE_CONTENT) restyle the chip the way they restyle the quote.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { IconPipeline } from '@/components/ui/icons';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import type { Result } from '@srtdio/posts';
import { readPostCards, type PostCardRow } from '../../../packages/posts/src/reads';

/** What a chip, a thread chip or title and the About bar show for one post. */
export type PostRefPost = Pick<PostCardRow, 'id' | 'number' | 'title' | 'thumbnailAssetVersionId'>;

/** A post in the batch: its row, null when not visible, undefined while unknown. */
export type PostRefLookup = (postId: string) => PostCardRow | null | undefined;

/** One thread's chip batch: a memo of resolved posts and the reads that fill it. */
export interface ChipBatch {
  get: PostRefLookup;
  /** A read for the post has finished or timed out at least once. */
  attempted: (postId: string) => boolean;
  /**
   * Read the ids not yet requested, in one call. Null when every id was already
   * requested (no read); otherwise resolves once the new ids are in, or once
   * the read has timed out.
   */
  request: (ids: readonly string[]) => Promise<void> | null;
}

/**
 * A read slower than this is given up on, and a read that fails (transport
 * error, a not-ok result) is treated the same: its ids go back to unknown at
 * the end of this window (the next request retries them, one read per window,
 * so a fast-failing offline fetch never spins; rows show the plain quote
 * meanwhile; About stays pending), never to null. Only a completed read that
 * returns no row for an id decides that post is not visible.
 */
export const CHIP_BATCH_TIMEOUT_MS = 4_000;

export function createChipBatch(
  load: (ids: string[]) => Promise<Result<PostCardRow[]>>,
  timeoutMs: number = CHIP_BATCH_TIMEOUT_MS,
): ChipBatch {
  const requested = new Set<string>();
  const resolved = new Map<string, PostCardRow | null>();
  const attempted = new Set<string>();
  return {
    get: (postId) => resolved.get(postId),
    attempted: (postId) => attempted.has(postId),
    request: (ids) => {
      const fresh = [...new Set(ids)].filter((id) => !requested.has(id)).sort();
      if (fresh.length === 0) return null;
      for (const id of fresh) requested.add(id);
      const window = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const read = load(fresh).then(
        (result): PostCardRow[] | 'failed' => (result.ok ? result.data : 'failed'),
        (): 'failed' => 'failed',
      );
      // A failure waits out the window too, so retries keep the window's cadence.
      const outcome = Promise.race([read, window]).then((first) =>
        first === 'failed' ? window : first,
      );
      return outcome.then((result) => {
        for (const id of fresh) attempted.add(id);
        if (result === 'timeout') {
          // Back to unknown; a late result, if any, is dropped.
          for (const id of fresh) requested.delete(id);
          return;
        }
        for (const id of fresh) resolved.set(id, null);
        for (const row of result) resolved.set(row.id, row);
      });
    },
  };
}

/** What the thread reads from its chip batch. */
export interface ChipLookup {
  postRef: PostRefLookup;
  /** The post is resolved (a row or null) or a read for it has been attempted. */
  chipSettled: (postId: string) => boolean;
}

/**
 * The thread's chip batch over `ids` (chip posts plus the thread and About
 * posts). A new batch per workspace; re-renders once each read lands or times
 * out, and a timed-out id is requested again on that render. With no workspace
 * there is nothing to read: every post is null (the plain quote).
 */
export function useChipBatch(ids: readonly string[]): ChipLookup {
  const { workspaceId } = useWorkspace();
  const [version, setVersion] = useState(0);
  const batchRef = useRef<{ workspaceId: string; batch: ChipBatch } | null>(null);
  if (workspaceId !== null && batchRef.current?.workspaceId !== workspaceId) {
    batchRef.current = {
      workspaceId,
      batch: createChipBatch((next) => readPostCards(supabase, { workspaceId, ids: next })),
    };
  }
  const batch = workspaceId !== null ? (batchRef.current?.batch ?? null) : null;
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (batch === null || key === '') return;
    void batch.request(key.split(','))?.then(() => setVersion((v) => v + 1));
    // version re-runs the request after a timeout put ids back to unknown.
  }, [batch, key, version]);
  return useMemo<ChipLookup>(
    () => ({
      postRef: (postId) => (batch !== null ? batch.get(postId) : null),
      chipSettled: (postId) =>
        batch === null || batch.get(postId) !== undefined || batch.attempted(postId),
    }),
    // version re-derives the lookup so consumers re-render with the new posts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batch, version],
  );
}

/**
 * A post's cover as a small thumbnail (round for chips, rounded for bars; the
 * 20px thread chip thumbnail at a 5px radius).
 */
export function PostRefThumb(props: {
  assetVersionId: string | null;
  size: 18 | 20 | 24 | 32;
  round?: boolean;
}): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  const box = { 18: 'h-[18px] w-[18px]', 20: 'h-5 w-5', 24: 'h-6 w-6', 32: 'h-8 w-8' }[props.size];
  return (
    <span
      ref={thumb.ref}
      aria-hidden="true"
      data-post-ref-thumb=""
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-panel-3 text-fg-3',
        box,
        props.round === true ? 'rounded-full' : props.size === 20 ? 'rounded-[5px]' : 'rounded-md',
      )}
    >
      {thumb.url !== null && !thumb.failed ? (
        <img
          src={thumb.url}
          alt=""
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : (
        <IconPipeline size={props.size <= 20 ? 11 : 16} />
      )}
    </span>
  );
}

/**
 * The chip itself: a 24px pill (18px round thumb, the post title truncated)
 * inside a 44px-tall tap target; never a KEY-N code. Tapping jumps to the card. The own
 * bubble's content overrides restyle it like the quote.
 */
export function PostRefChip(props: {
  post: PostRefPost;
  onTap: () => void;
  className?: string;
}): ReactElement {
  const { post } = props;
  return (
    <button
      type="button"
      data-post-ref={post.id}
      data-msg-link=""
      aria-label={`Go to the card about ${post.title}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onTap();
      }}
      className={cn('flex min-h-[44px] min-w-0 max-w-full items-center text-left', props.className)}
    >
      <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-panel-3 pl-[3px] pr-2.5">
        <PostRefThumb assetVersionId={post.thumbnailAssetVersionId} size={18} round />
        <span className="min-w-0 truncate text-sm text-fg-2">{post.title}</span>
      </span>
    </button>
  );
}
