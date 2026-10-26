// Pure, React-free helpers for rendering shared posts in the message thread. The
// view dispatch is derived from the message's shared post ids and the batched
// resolve, so it is unit-tested without a DOM: every id maps to exactly one card,
// and an id the RLS-scoped read did not return (e.g. a client receiving a draft)
// maps to a neutral "not visible" card rather than throwing or leaking. The card's
// footer wording, media pills and refetch triggers are decided here too.

import type { PostCardRow } from '../../../packages/posts/src/reads';
import { formatDate, formatDateTime } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { onBehalfSuffix } from '@/components/pages/pcs/roles';
import { entityUrlPath } from '@/lib/entityRef';

/** The route a shared post card navigates to (the existing /posts/:id view). */
export function postRoute(id: string): string {
  return `/posts/${id}`;
}

/**
 * Where "Open post" goes: the pretty /p/<key>-<number> link when the workspace
 * key and the post number are known, else the classic /posts/:id route.
 */
export function postHref(
  id: string,
  number: number | null | undefined,
  workspaceKey: string | null | undefined,
): string {
  return typeof workspaceKey === 'string' &&
    workspaceKey !== '' &&
    typeof number === 'number' &&
    Number.isInteger(number) &&
    number > 0
    ? entityUrlPath('post', workspaceKey, number)
    : postRoute(id);
}

/** The render branch for one shared post id. */
export type SharedPostView =
  | {
      kind: 'post';
      postId: string;
      post: PostCardRow;
      approverName: string | null;
      /** The approver's workspace role (one batched read); null or absent when unread or failed. */
      approverRole?: string | null;
      /** The creator's display name when the caller has it; absent or null reads "The creator". */
      creatorName?: string | null;
    }
  | { kind: 'not_visible'; postId: string };

/** Copy for the neutral card shown when the reader's RLS hides a shared post. */
export const NOT_VISIBLE_TITLE = 'Post not visible to you yet';
export const NOT_VISIBLE_BODY = 'It will appear here once it is shared for review';

/** Index a batched post resolve by id for O(1) per-id lookup (no per-id scan). */
export function indexPostsById<T extends { id: string }>(posts: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const post of posts) map.set(post.id, post);
  return map;
}

/** The distinct, non-null approver ids of a batch: the input of ONE name lookup. */
export function approverIds(posts: readonly Pick<PostCardRow, 'approved_by'>[]): string[] {
  const ids = new Set<string>();
  for (const post of posts) if (post.approved_by !== null) ids.add(post.approved_by);
  return [...ids];
}

/** The first word of a display name; blank stays blank. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/**
 * One view per shared post id, preserving the message's order. An id present in
 * the resolve renders as a card; an id the resolve did not return renders as a
 * "not visible" card. `names` maps approver user ids to display names and
 * `roles` maps them to workspace roles (both from the same batched pass). The
 * viewer's RLS is the security boundary: a post the viewer cannot see simply
 * never appears in `postsById`.
 */
export function sharedPostViews(
  ids: readonly string[],
  postsById: Map<string, PostCardRow>,
  names: ReadonlyMap<string, string> = new Map(),
  roles: ReadonlyMap<string, string> = new Map(),
): SharedPostView[] {
  return ids.map((postId) => {
    const post = postsById.get(postId);
    if (post === undefined) return { kind: 'not_visible', postId };
    const name = post.approved_by !== null ? names.get(post.approved_by) : undefined;
    const first = name !== undefined ? firstName(name) : '';
    const role = post.approved_by !== null ? (roles.get(post.approved_by) ?? null) : null;
    return {
      kind: 'post',
      postId,
      post,
      approverName: first !== '' ? first : null,
      approverRole: role,
    };
  });
}

/**
 * The approver as a label names them: "Chitra", or "Chitra on behalf of Zomato"
 * when the approver is agency-side (no brand: "on behalf of the approvers"). No
 * role (old data or a failed read) is the name alone; no name is null.
 */
export function approverLabel(
  approverName: string | null,
  approverRole: string | null | undefined,
  brand: string | null = null,
): string | null {
  return approverName !== null ? `${approverName}${onBehalfSuffix(approverRole, brand)}` : null;
}

/** The card footer: the state on the left, one action label on the right. */
interface CardFooter {
  state: string;
  action: 'Open' | 'Review';
  /** Accent ink for the state (the viewer is the one being waited on). */
  accent: boolean;
  /** A leading check glyph (approved). */
  check: boolean;
}

/**
 * The footer for a card, by stage and the viewer's side. Approved names the
 * approver (first name, plus "on behalf of client" when agency-side; pass it
 * through approverLabel) and when; with no approver on record (or no resolvable
 * name) it falls back to the date the post entered approved. Review words by
 * side: the client is waited on ("Review"), the agency waits; an unknown side
 * reads neutral. Every other stage is its label with "Open".
 */
export function cardFooter(
  post: Pick<PostCardRow, 'stage' | 'approved_at' | 'stage_entered_at'>,
  approverName: string | null,
  side: ViewerSide,
  /** For tests; the app passes none (the viewer's device zone). */
  timeZone?: string,
): CardFooter {
  const plain = { action: 'Open', accent: false, check: false } as const;
  switch (post.stage) {
    case 'approved': {
      if (approverName !== null && post.approved_at !== null) {
        const at = formatDateTime(post.approved_at, undefined, timeZone);
        return {
          ...plain,
          check: true,
          state: at === '' ? `Approved by ${approverName}` : `Approved by ${approverName} · ${at}`,
        };
      }
      const on = formatDate(post.stage_entered_at, undefined, timeZone);
      return { ...plain, check: true, state: on === '' ? 'Approved' : `Approved · ${on}` };
    }
    case 'review':
      if (side === 'client')
        return { state: 'Waiting on you', action: 'Review', accent: true, check: false };
      if (side === 'agency') return { ...plain, state: 'Waiting on approvers' };
      return { ...plain, state: 'In review' };
    case 'draft':
      return { ...plain, state: 'Draft' };
    case 'parked':
      return { ...plain, state: 'Parked' };
    case 'rejected':
      return { ...plain, state: 'Rejected' };
    default:
      return { ...plain, state: post.stage.charAt(0).toUpperCase() + post.stage.slice(1) };
  }
}

/** The media-corner pills: "<n> slides" past one item, and a video label. */
export function mediaPills(post: Pick<PostCardRow, 'mediaCount' | 'hasVideo' | 'format'>): {
  slides: string | null;
  video: string | null;
} {
  return {
    slides: post.mediaCount > 1 ? `${post.mediaCount} slides` : null,
    video: post.hasVideo ? (post.format === 'video' ? 'Reel' : 'Video') : null,
  };
}

/** The window event PR 3's sheet dispatches after it changes a post. */
export const POST_CHANGED_EVENT = 'sorted:post-changed';

/** A returning tab refetches the batch only when it is older than this. */
export const REFETCH_AFTER_MS = 60_000;

/** Whether a tab becoming visible again should refetch a batch fetched at `fetchedAt`. */
export function staleOnVisible(fetchedAt: number, now: number): boolean {
  return now - fetchedAt > REFETCH_AFTER_MS;
}

/** Whether a post-changed event's detail names a post in this batch. */
export function eventTouchesBatch(detail: unknown, ids: readonly string[]): boolean {
  if (typeof detail !== 'object' || detail === null) return false;
  const postId = (detail as { postId?: unknown }).postId;
  return typeof postId === 'string' && ids.includes(postId);
}

/** The event sources the freshness watcher listens on (window and document in the app). */
export interface FreshnessTargets {
  window: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: string;
  };
}

/**
 * Watch one batch for staleness without a realtime subscription: refetch when the
 * tab becomes visible again more than {@link REFETCH_AFTER_MS} after the last
 * fetch, and when a {@link POST_CHANGED_EVENT} names a post in the batch. Returns
 * the unsubscribe. React-free so the triggers are unit tested with plain targets.
 */
export function watchBatchFreshness(
  targets: FreshnessTargets,
  opts: {
    ids: () => readonly string[];
    fetchedAt: () => number;
    now: () => number;
    refetch: () => void;
  },
): () => void {
  const onVisibility = (): void => {
    if (targets.document.visibilityState !== 'visible') return;
    if (staleOnVisible(opts.fetchedAt(), opts.now())) opts.refetch();
  };
  const onChanged = (event: Event): void => {
    if (eventTouchesBatch((event as CustomEvent<unknown>).detail, opts.ids())) opts.refetch();
  };
  targets.document.addEventListener('visibilitychange', onVisibility);
  targets.window.addEventListener(POST_CHANGED_EVENT, onChanged);
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisibility);
    targets.window.removeEventListener(POST_CHANGED_EVENT, onChanged);
  };
}
