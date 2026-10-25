// Renders the posts shared into one message as live cards. Every card in a
// thread reads through the thread's card cache (shared-cards.ts, provided by
// SharedCardsProvider): all the thread's shared post ids resolve in ONE
// batched readPostCards (a posts IN read plus one asset_attachments IN read,
// chunks of 100, 5s each) and one readProfiles call plus one workspace_members
// role read (in parallel) for the distinct approvers, never one read per bubble; the briefs the same way (BriefCard). The
// viewer's RLS gates visibility: a post they cannot see comes back absent and
// renders as a neutral "not visible" card, no content leaks. Cards
// paint only once the batch AND the viewer's side have resolved, so the footer
// wording never flips after first paint. No realtime: the batch refetches when
// the tab returns after a minute away, or when a sorted:post-changed event names
// one of its posts. The cover presigns lazily through the shared thumbnail hook.
// Tapping a card opens its PostSheet (media, facts, the viewer's action) instead
// of navigating; the sheet portals above the thread. Holding a card (450 ms,
// 10 px) brings its post into the conversation (onTalkAbout) and the click that
// ends the hold is swallowed, so the sheet does not open. No card shows a
// KEY-N code.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
  SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { ICON_SIZE, IconCheck, IconPlay } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import {
  CHAT_CARD_FRAME_MAX_HEIGHT,
  frameMediaClass,
  PlatformFrame,
} from '@/components/media/PlatformFrame';
import { frameFor, type Frame } from '@/lib/platform-specs';
import type { PresignCache } from '@/lib/asset-presign';
import { appPresignCache, appPresignDeps } from '@/lib/shared-presign';
import { READ_TIMEOUT_MS, readProfiles } from '@/lib/chat-reads';
import { readBriefsByIds, type BriefCardFields } from '@/lib/chat/briefs';
import {
  createSharedCardCache,
  type SharedCardCache,
  type SharedCardReaders,
} from '@/lib/chat/shared-cards';
import { formatDateTime, formatDueDate } from '@/lib/time';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import {
  POST_CARD_META_TYPE,
  POST_CARD_TITLE_TYPE,
  sized,
  useChatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';
import { env } from '@/lib/env';
import { formatLabel } from '@/lib/post-detail-presentation';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import type { Client } from '@srtdio/rpc';
import { PostSheet } from '@/components/chat/PostSheet';
import {
  readPostCards,
  type CardFirstMedia,
  type PostCardRow,
} from '../../../packages/posts/src/reads';
import {
  NOT_VISIBLE_BODY,
  NOT_VISIBLE_TITLE,
  approverIds,
  approverLabel,
  cardFooter,
  indexPostsById,
  mediaPills,
  sharedPostViews,
  watchBatchFreshness,
  type SharedPostView,
} from '@/components/chat/post-card';
import { INDUCTION_KEYS } from '@/lib/induction';

/** Title-case a stage value for its chip (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** One resolved batch: the visible posts plus approver names and roles by user id. */
export interface PostCardBatch {
  posts: PostCardRow[];
  names: Map<string, string>;
  roles: Map<string, string>;
}

/**
 * The approver role read is capped inside the names read's own 5s budget, so a
 * hung role read degrades to "name only" instead of taking the names down too.
 */
export const APPROVER_ROLE_CAP_MS = READ_TIMEOUT_MS - 1_000;

/**
 * ONE workspace_members IN read of the approvers' roles, for the "on behalf of
 * client" suffix. Best-effort: a failed or capped read is an empty map, so the
 * label reads the name only. Never throws.
 */
export async function readApproverRoles(
  client: Client,
  workspaceId: string,
  userIds: readonly string[],
  signal?: AbortSignal,
  capMs: number = APPROVER_ROLE_CAP_MS,
): Promise<Map<string, string>> {
  const roles = new Map<string, string>();
  if (userIds.length === 0) return roles;
  const base = client
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .in('user_id', [...userIds]);
  const query = signal !== undefined ? base.abortSignal(signal) : base;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), capMs);
  });
  const rows = await Promise.race([
    Promise.resolve(query).then(
      (res) => (res.error ? null : (res.data ?? [])),
      () => null,
    ),
    capped,
  ]).finally(() => clearTimeout(timer));
  for (const row of rows ?? []) {
    if (typeof row.role === 'string') roles.set(row.user_id, row.role);
  }
  return roles;
}

/**
 * Resolve one message's batch: readPostCards (at most two queries) then ONE
 * readProfiles and ONE role read over the distinct approver ids, in parallel
 * (skipped when there are none). Null when the posts read fails; a failed name
 * read only drops the names (the approved footer falls back to its date), a
 * failed role read only drops the suffix.
 */
export async function loadPostCardBatch(
  client: Client,
  workspaceId: string,
  ids: string[],
): Promise<PostCardBatch | null> {
  const result = await readPostCards(client, { workspaceId, ids });
  if (!result.ok) return null;
  const names = new Map<string, string>();
  let roles = new Map<string, string>();
  const approvers = approverIds(result.data);
  if (approvers.length > 0) {
    const [profiles, found] = await Promise.all([
      readProfiles(client, approvers),
      readApproverRoles(client, workspaceId, approvers),
    ]);
    if (profiles.ok) for (const p of profiles.data) names.set(p.userId, p.displayName);
    roles = found;
  }
  return { posts: result.data, names, roles };
}

/** One thread's card cache: its shared posts and briefs, batched. */
export type ThreadCardCache = SharedCardCache<PostCardRow, BriefCardFields>;

/**
 * The existing batched readers, bound to one workspace, for a thread's card
 * cache. The approver name read also reads their roles (one workspace_members
 * IN read, in parallel) into `roles`, so a name and its "on behalf of client"
 * suffix land in the same render: the label never flips after first paint.
 */
export function threadCardReaders(
  client: Client,
  workspaceId: string,
  roles: Map<string, string> = new Map(),
): SharedCardReaders<PostCardRow, BriefCardFields> {
  return {
    // readPostCards takes no signal (a shared package): its reads are bounded, not aborted.
    readPosts: (ids) => readPostCards(client, { workspaceId, ids }),
    readBriefs: (ids, signal) => readBriefsByIds(client, { workspaceId, ids, signal }),
    readNames: async (userIds, signal) => {
      const [profiles, found] = await Promise.all([
        readProfiles(client, userIds, signal),
        readApproverRoles(client, workspaceId, userIds, signal),
      ]);
      for (const [userId, role] of found) roles.set(userId, role);
      return profiles;
    },
    postId: (post) => post.id,
    briefId: (brief) => brief.id,
    approverIds: (posts) => approverIds(posts),
  };
}

const SharedCardsContext = createContext<ThreadCardCache | null>(null);

/** Each card cache's approver roles, filled by its own name reads. */
const approverRolesByCache = new WeakMap<ThreadCardCache, Map<string, string>>();
const NO_ROLES: ReadonlyMap<string, string> = new Map();

/** A thread card cache over the batched readers, with its approver-role map. */
export function createThreadCardCache(client: Client, workspaceId: string): ThreadCardCache {
  const roles = new Map<string, string>();
  const cache = createSharedCardCache(threadCardReaders(client, workspaceId, roles));
  approverRolesByCache.set(cache, roles);
  return cache;
}

/** The approver roles a cache's name reads have resolved (empty for none). */
export function approverRolesOf(cache: ThreadCardCache | null): ReadonlyMap<string, string> {
  return cache !== null ? (approverRolesByCache.get(cache) ?? NO_ROLES) : NO_ROLES;
}

/**
 * The thread's card cache, one per open chat and workspace (a switch or unmount
 * disposes it and ignores its reads in flight). It asks for every shared post
 * and brief id across the loaded messages at once, so the page's cards resolve
 * in one posts read, one briefs read and one names read; a new message adds only
 * its missing ids.
 */
export function SharedCardsProvider(props: {
  workspaceId: string | null;
  channelId: string | null;
  postIds: readonly string[];
  briefIds: readonly string[];
  /** The chat connection status: each transition to 'connected' retries failed card reads. */
  status?: string;
  children: ReactNode;
}): ReactElement {
  const { workspaceId, channelId } = props;
  const cache = useMemo(
    () =>
      workspaceId !== null && channelId !== null
        ? createThreadCardCache(supabase, workspaceId)
        : null,
    [workspaceId, channelId],
  );
  // StrictMode runs this cleanup and the effect again with the same cache:
  // resume makes that remount a live cache, not a disposed one.
  useEffect(() => {
    cache?.resume();
    return () => cache?.dispose();
  }, [cache]);
  const postKey = props.postIds.join(',');
  const briefKey = props.briefIds.join(',');
  const idsRef = useRef({ postIds: props.postIds, briefIds: props.briefIds });
  idsRef.current = { postIds: props.postIds, briefIds: props.briefIds };
  useEffect(() => {
    cache?.request(idsRef.current);
  }, [cache, postKey, briefKey]);
  // Failed card reads retry when the tab comes back, the browser is online
  // again, or chat (re)connects.
  useEffect(() => {
    if (cache === null) return;
    return watchCardRetries({ window, document }, () => cache.retryFailed());
  }, [cache]);
  const status = props.status;
  useEffect(() => {
    if (status === 'connected') cache?.retryFailed();
  }, [cache, status]);
  return <SharedCardsContext.Provider value={cache}>{props.children}</SharedCardsContext.Provider>;
}

/** The targets the card retry triggers listen on (window and document, or test fakes). */
export interface CardRetryTargets {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

/** Call `retry` on tab visible and on online; returns the unsubscribe. */
export function watchCardRetries(
  targets: CardRetryTargets,
  retry: (reason: 'visible' | 'online') => void,
): () => void {
  const onVisible = (): void => {
    if (targets.document.visibilityState === 'visible') retry('visible');
  };
  const onOnline = (): void => retry('online');
  targets.document.addEventListener('visibilitychange', onVisible);
  targets.window.addEventListener('online', onOnline);
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisible);
    targets.window.removeEventListener('online', onOnline);
  };
}

/**
 * A card skeleton scrolled INTO view (off screen, then on) retries its failed
 * reads (tries left only); where it starts does not count, so a render never
 * spends a try. Returns a stable ref for the skeleton's box.
 */
export function useRetryInView(
  cache: ThreadCardCache | null,
  ids: { postIds?: readonly string[]; briefIds?: readonly string[] },
  active: boolean,
): (node: HTMLDivElement | null) => void {
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (node === null || !active || cache === null) return;
      if (typeof IntersectionObserver === 'undefined') return;
      let seen: boolean | null = null;
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (seen === false && visible) cache.retryFailed(idsRef.current);
        seen = visible;
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [cache, active],
  );
}

/** Copy for a card whose reads failed every try (not a permission state). */
export const CARD_LOAD_FAILED = "Couldn't load";

/** A card whose reads failed every try: neutral, one 44px tap re-reads it. */
export function CouldntLoadCard(props: { onRetry: () => void }): ReactElement {
  return (
    <PressableRow
      inline
      card
      type="button"
      data-card-failed=""
      onClick={props.onRetry}
      // inline (w-auto) plus a fixed min/max of 240: the shared card's width
      // without a w-* class against PressableRow's own.
      className={`${SHARED_CARD_BODY} min-w-[240px] max-w-[240px] bg-panel-2 text-fg-2`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-base font-medium">{CARD_LOAD_FAILED}</span>
        <span className="truncate text-sm">Tap to try again</span>
      </span>
    </PressableRow>
  );
}

const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_VERSION = (): number => 0;

/**
 * The thread's card cache, or (outside a thread) one of this card's own, so a
 * card rendered anywhere still reads in one batch per message. Pure plumbing.
 */
export function useThreadCardCache(): ThreadCardCache | null {
  const { workspaceId } = useWorkspace();
  const shared = useContext(SharedCardsContext);
  const local = useMemo(
    () =>
      shared === null && workspaceId !== null ? createThreadCardCache(supabase, workspaceId) : null,
    [shared, workspaceId],
  );
  useEffect(() => {
    local?.resume();
    return () => local?.dispose();
  }, [local]);
  const cache = shared ?? local;
  // Re-render on every applied read.
  useSyncExternalStore(cache?.subscribe ?? NO_SUBSCRIBE, cache?.version ?? NO_VERSION);
  return cache;
}

/**
 * Resolve and keep fresh one message's shared posts through the thread's card
 * cache. While an id has not settled `loading` is true (skeleton); a read that
 * failed or timed out retries on the next trigger, and after every try the id
 * is in `failed` ("Couldn't load", tap to retry), never "not visible". A
 * refetch keeps the current cards on screen.
 */
function useSharedPosts(postIds: string[]): {
  views: SharedPostView[];
  loading: boolean;
  failed: string[];
  cache: ThreadCardCache | null;
} {
  const cache = useThreadCardCache();
  const batchKey = postIds.join(',');
  const idsRef = useRef(postIds);
  idsRef.current = postIds;

  useEffect(() => {
    if (idsRef.current.length > 0) cache?.request({ postIds: idsRef.current });
  }, [cache, batchKey]);

  useEffect(() => {
    if (cache === null) return;
    return watchBatchFreshness(
      { window, document },
      {
        ids: () => idsRef.current,
        fetchedAt: () => cache.postsFetchedAt(idsRef.current),
        now: () => Date.now(),
        refetch: () => cache.refreshPosts(idsRef.current),
      },
    );
  }, [cache]);

  const snapshot =
    cache !== null && postIds.length > 0
      ? cache.posts(postIds)
      : { loading: false, posts: [], failed: [], names: new Map<string, string>() };
  const version = cache?.version() ?? 0;
  const views = useMemo(
    () =>
      sharedPostViews(
        postIds,
        indexPostsById(snapshot.posts),
        snapshot.names,
        approverRolesOf(cache),
      ),
    // The snapshot is keyed by the ids and the cache version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchKey, cache, version],
  );
  return { views, loading: snapshot.loading, failed: snapshot.failed, cache };
}

/**
 * The viewer's side, settled within the read timeout: a side read that never
 * answers stops holding the cards after 5s. `known` is false until a real
 * side is read (also when the read failed and settled as 'unknown'), and the
 * cards paint with no footer meanwhile (never a footer for an unknown side
 * that flips later). Each workspace, a return to one included, starts the cap
 * again.
 */
function useSettledViewerSide(workspaceId: string | null): {
  side: ViewerSide;
  ready: boolean;
  known: boolean;
} {
  const { side, ready } = useViewerSide(workspaceId);
  const [expired, setExpired] = useState(false);
  // Every workspace (a return to one included) starts its own 5s cap.
  useEffect(() => {
    setExpired(false);
    if (ready || workspaceId === null) return;
    const timer = setTimeout(() => setExpired(true), READ_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, workspaceId]);
  // A side read that failed or timed out reads 'unknown': no footer for it,
  // so the card never paints an unknown side's wording that flips later.
  return { side, ready: ready || expired, known: ready && side !== 'unknown' };
}

// One presign cache for every shared card in the session: it bounds concurrency
// and keeps URLs warm across messages. Created on first use, never per card. The
// post sheet shares it, and its deps mint the viewer's download URL.
/** The app-wide presign cache (one for every screen; see shared-presign). */
export function sharedCardPresignCache(): PresignCache {
  return appPresignCache();
}
export const PRESIGN_ENABLED =
  env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

/** Talk-about and thread hooks a thread hands its cards; absent disables both. */
export interface CardRefActions {
  /** Hold on a card, or the sheet's "Talk about": bring the post into the conversation. */
  onTalkAbout?: ((postId: string) => void) | undefined;
  /**
   * Called inside the user event that ends a Talk about (the hold's release,
   * the sheet's tap): focus the composer there, where iOS opens the keyboard.
   */
  onTalkAboutFocus?: (() => void) | undefined;
}

export function SharedPostCards({
  postIds,
  messageId,
  onTalkAbout,
  onTalkAboutFocus,
}: {
  postIds: string[];
  /** The card message's id, handed to onTalkAbout. */
  messageId?: string;
  onTalkAbout?: ((postId: string, messageId: string) => void) | undefined;
  onTalkAboutFocus?: (() => void) | undefined;
}): ReactElement | null {
  const { workspaceId, workspaces, workspaceName } = useWorkspace();
  const { side, ready, known } = useSettledViewerSide(workspaceId);
  // Due dates are calendar days on the workspace zone (src/lib/time.ts).
  const workspaceZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? null;
  const { views, loading, failed, cache } = useSharedPosts(postIds);
  const retryInView = useRetryInView(cache, { postIds }, loading);
  if (postIds.length === 0) return null;
  if (loading || !ready) {
    return (
      <div ref={retryInView} className="mt-1.5 flex flex-col items-start gap-1.5">
        {postIds.map((id) => (
          <div key={id} className={`${CARD_SKELETON} animate-pulse`} />
        ))}
      </div>
    );
  }
  return (
    <SharedPostCardList
      views={views}
      failed={failed}
      onRetry={(ids) => cache?.retry({ postIds: ids })}
      side={side}
      sideKnown={known}
      workspaceZone={workspaceZone}
      brand={workspaceName ?? null}
      onTalkAbout={
        onTalkAbout !== undefined && messageId !== undefined
          ? (postId) => onTalkAbout(postId, messageId)
          : undefined
      }
      onTalkAboutFocus={onTalkAboutFocus}
    />
  );
}

/**
 * An approved card whose approver name is not loaded (none on record, or the
 * name read failed) reads "Approved · <date time>" from approved_at, never a
 * blank name. Other footers pass through. `timeZone` is for tests. Pure.
 */
export function approvedWithoutName<F extends { state: string }>(
  footer: F,
  post: Pick<PostCardRow, 'stage' | 'approved_at'>,
  approverName: string | null,
  timeZone?: string,
): F {
  if (post.stage !== 'approved' || approverName !== null || post.approved_at === null) {
    return footer;
  }
  const at = formatDateTime(post.approved_at, undefined, timeZone);
  if (at === '') return footer;
  return { ...footer, state: `Approved · ${at}` };
}

/** Everything a card needs besides its view; resolved once per message. */
export interface CardContext {
  side: ViewerSide;
  /** The side read has answered; false after its 5s cap: no footer is painted. */
  sideKnown?: boolean;
  /** For tests: the zone moments render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** The workspace's zone: the target (due) date reads its calendar day on it. */
  workspaceZone?: string | null | undefined;
  /** The workspace's brand name for "on behalf of <Brand>"; null falls back. */
  brand?: string | null;
}

/** The resolved cards in postIds order (presentational; no reads). */
export function SharedPostCardList(
  props: {
    views: SharedPostView[];
    /** Ids whose reads failed every try: "Couldn't load" in their place. */
    failed?: readonly string[];
    onRetry?: (postIds: string[]) => void;
  } & CardContext &
    CardRefActions,
): ReactElement {
  const { views, onTalkAbout, onTalkAboutFocus, failed = [], onRetry, ...context } = props;
  const failedIds = new Set(failed);
  return (
    <div
      data-induction={INDUCTION_KEYS.chatPostCard}
      className="mt-1.5 flex flex-col items-start gap-1.5"
    >
      {views.map((view) =>
        failedIds.has(view.postId) ? (
          <CouldntLoadCard key={view.postId} onRetry={() => onRetry?.([view.postId])} />
        ) : view.kind === 'not_visible' ? (
          <NotVisibleCard key={view.postId} />
        ) : (
          <PostCardItem
            key={view.postId}
            view={view}
            {...context}
            {...(onTalkAbout !== undefined ? { onTalkAbout: () => onTalkAbout(view.postId) } : {})}
            {...(onTalkAboutFocus !== undefined ? { onTalkAboutFocus } : {})}
          />
        ),
      )}
    </div>
  );
}

/** The shared card box: one tappable row, thumb + title over meta. */
const SHARED_CARD_BODY =
  'flex items-center gap-2.5 rounded-xl border border-border px-2.5 py-2 min-h-[44px]';
const SHARED_CARD_BOX = `w-[240px] ${SHARED_CARD_BODY}`;
export const SHARED_CARD = `${SHARED_CARD_BOX} bg-panel`;

/** The live post card frame: media (optional), body, footer stacked. */
export const POST_CARD =
  'flex w-[240px] flex-col overflow-hidden rounded-xl border border-border bg-panel text-left';

/** A loading card: the height of a no-media card (one title line, meta row, footer). */
export const CARD_SKELETON = 'h-[118px] w-[240px] rounded-xl border border-border bg-panel-2';

/** A small pill laid over the cover image. */
const MEDIA_PILL =
  'inline-flex h-5 items-center gap-1 rounded-md bg-panel px-1.5 text-xs font-medium text-fg';

/**
 * The card's tap and Enter key: both open its sheet, neither navigates (the sheet
 * carries "Open full post"). A click that ends a long-press (consumeHold reads
 * and clears the hold's suppression flag) is swallowed, as the bubble does. Pure
 * so the wiring is tested without a DOM.
 */
export function cardTapHandlers(
  openSheet: () => void,
  consumeHold: () => boolean = () => false,
): {
  onClick: () => void;
  onKeyDown: (e: Pick<KeyboardEvent<HTMLDivElement>, 'key' | 'preventDefault'>) => void;
} {
  return {
    onClick: () => {
      if (consumeHold()) return;
      openSheet();
    },
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openSheet();
    },
  };
}

/** A card's hold: 450 ms still within 10 px, the bubble's long-press defaults. */
export const CARD_HOLD = { thresholdMs: 450, moveTolerancePx: 10 } as const;

/** A card hold's Talk about, remembered until the finger lifts. */
export interface TalkAboutHold {
  /**
   * The hold fired (on its timer). With focusNow (a fine pointer) the composer
   * takes focus right here and the release does nothing more; without it
   * (touch) the focus waits for the release.
   */
  held: (focusNow?: (() => void) | undefined) => void;
  /** The press ended: focus once, inside this pointerup, when the hold fired. */
  release: (focus: (() => void) | undefined) => void;
  /** A new press or a cancelled one: forget the hold. */
  reset: () => void;
}

/**
 * Whether a card hold focuses the composer when it fires: a laptop layout or a
 * mouse press (desktop browsers take focus from a timer, so a mouse that drifts
 * off the card before release still lands the cursor). Touch waits for the
 * release, where iOS opens the keyboard. Pure.
 */
export function holdFocusesOnFire(input: { layout: ChatLayout; pointerType: string }): boolean {
  return input.layout === 'laptop' || input.pointerType === 'mouse';
}

/**
 * Decision 128 for a card hold: the hold fires on a timer, where iOS WebKit
 * opens no keyboard, so on touch the composer takes focus on the release that
 * ends it. A fine pointer focuses as the hold fires. Pure.
 */
export function createTalkAboutHold(): TalkAboutHold {
  let fired = false;
  return {
    held: (focusNow) => {
      if (focusNow !== undefined) {
        fired = false;
        focusNow();
        return;
      }
      fired = true;
    },
    release: (focus) => {
      if (!fired) return;
      fired = false;
      focus?.();
    },
    reset: () => {
      fired = false;
    },
  };
}

/** The sheet's "Talk about" tap: the post comes in, then the composer takes focus, before the sheet closes. Pure. */
export function talkAboutThenFocus(
  talkAbout: () => void,
  focus: (() => void) | undefined,
): () => void {
  return () => {
    talkAbout();
    focus?.();
  };
}

export function PostCardItem(
  props: { view: Extract<SharedPostView, { kind: 'post' }> } & CardContext & {
      onTalkAbout?: () => void;
      onTalkAboutFocus?: () => void;
    },
): ReactElement {
  const { view, side, timeZone } = props;
  const { post } = view;
  const approver = approverLabel(view.approverName, view.approverRole, props.brand ?? null);
  const footer = approvedWithoutName(
    cardFooter(post, approver, side, timeZone),
    post,
    approver,
    timeZone,
  );
  const target =
    post.target_date !== null ? formatDueDate(post.target_date, props.workspaceZone) : '';
  const frame = cardFrame(post);
  // The card shows media only when it has a first photo or video AND a frame.
  const media = frame !== null ? post.firstMedia : null;
  // The sheet mounts on first open and stays mounted so its exit can animate.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const layout = useChatLayout();
  const onTalkAbout = props.onTalkAbout;
  const talkRef = useRef<TalkAboutHold | null>(null);
  talkRef.current ??= createTalkAboutHold();
  const talk = talkRef.current;
  // The press's pointer type: a mouse hold focuses as it fires.
  const pressPointer = useRef('');
  const hold = useLongPress(() => {
    onTalkAbout?.();
    const now = holdFocusesOnFire({ layout, pointerType: pressPointer.current });
    talk.held(now ? props.onTalkAboutFocus : undefined);
  }, CARD_HOLD);
  // A touch hold also fires contextmenu (Android): the hold is the card's, so
  // the bubble's action menu stays shut. A mouse right-click still reaches it.
  const touchPress = useRef(false);
  const tap = cardTapHandlers(() => {
    setSheetMounted(true);
    setSheetOpen(true);
  }, hold.consumeClickSuppression);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-msg-link=""
        aria-haspopup="dialog"
        aria-label={`Open post ${post.title}`}
        {...(onTalkAbout !== undefined
          ? {
              ...hold.handlers,
              onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
                touchPress.current = e.pointerType !== 'mouse';
                pressPointer.current = e.pointerType;
                talk.reset();
                // A hold released off the card left its click guard set: a new
                // press is never the tail of that hold.
                hold.clearClickSuppression();
                hold.handlers.onPointerDown(e);
              },
              // The hold fired on a timer, where iOS opens no keyboard: the
              // composer takes focus here, inside the release.
              onPointerUp: () => {
                hold.handlers.onPointerUp();
                talk.release(props.onTalkAboutFocus);
              },
              onPointerCancel: () => {
                hold.handlers.onPointerCancel();
                talk.reset();
              },
              // Released off the card: that press never focuses later.
              onPointerLeave: () => talk.reset(),
              // A mouse press on the card is the hold's alone: no native press
              // handling (WebKit's moves the caret the hold just put in the
              // composer on release). Touch presses are left as they were.
              onMouseDown: (e: MouseEvent<HTMLDivElement>) => {
                if (e.button === 0 && pressPointer.current === 'mouse') e.preventDefault();
              },
              onContextMenu: (e: MouseEvent<HTMLDivElement>) => {
                if (!touchPress.current) return;
                e.preventDefault();
                e.stopPropagation();
              },
            }
          : {})}
        onClick={tap.onClick}
        onKeyDown={tap.onKeyDown}
        className={cn(POST_CARD, 'cursor-pointer transition-colors hover:bg-panel-2')}
      >
        {media !== null && frame !== null ? (
          <CardMedia post={post} frame={frame} media={media} />
        ) : null}
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          <span
            data-card-title=""
            className={cn('line-clamp-2 text-fg', sized(POST_CARD_TITLE_TYPE, layout))}
            title={post.title}
          >
            {post.title}
          </span>
          <span className={cn('flex items-center gap-1.5 text-fg-3', POST_CARD_META_TYPE)}>
            <Tag
              label={stageLabel(post.stage)}
              {...(isTagDot(post.stage) ? { dot: post.stage } : {})}
            />
            {target !== '' ? <span data-card-target="">{target}</span> : null}
          </span>
        </div>
        {props.sideKnown !== false ? (
          <div
            data-card-footer=""
            className="flex h-[44px] items-center justify-between gap-2 border-t border-border px-3 text-sm"
          >
            <span
              className={cn(
                'flex min-w-0 items-center gap-1',
                footer.accent ? 'font-medium text-accent' : 'text-fg-2',
              )}
            >
              {footer.check ? (
                <IconCheck size={ICON_SIZE.inline} className="shrink-0 text-good" />
              ) : null}
              <span className="truncate">{footer.state}</span>
            </span>
            <span className="shrink-0 font-medium text-accent">{footer.action}</span>
          </div>
        ) : null}
      </div>
      {sheetMounted ? (
        <SheetBoundary>
          <PostSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            view={view}
            side={side}
            timeZone={timeZone}
            cache={sharedCardPresignCache()}
            deps={appPresignDeps}
            presignEnabled={PRESIGN_ENABLED}
            {...(onTalkAbout !== undefined
              ? { onTalkAbout: talkAboutThenFocus(onTalkAbout, props.onTalkAboutFocus) }
              : {})}
          />
        </SheetBoundary>
      ) : null}
    </>
  );
}

const stop = (e: SyntheticEvent): void => e.stopPropagation();

/**
 * React events bubble through portals along the component tree, so a tap inside
 * the sheet would otherwise reach the message bubble (long-press, swipe-reply,
 * the card's own open). This portal root stops them at the card.
 */
function SheetBoundary({ children }: { children: ReactNode }): ReactElement {
  return createPortal(
    <div
      onClick={stop}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * The card's media frame: the post's platform + format shape (frameFor) fed the
 * first photo or video with its stored size, so the frame follows the real
 * media within the platform's rules; a size not stored (older uploads) falls
 * back to the format's default. null for a format with no media box (text,
 * link) and for a media-optional format with no media (thread): the card stays
 * a non-media card. Pure.
 */
export function cardFrame(
  post: Pick<PostCardRow, 'platform' | 'format' | 'firstMedia'>,
): Frame | null {
  const first = post.firstMedia;
  return frameFor(
    post.platform,
    post.format,
    first === null ? null : { kind: first.kind, w: first.width, h: first.height },
  );
}

interface CardMediaProps {
  post: PostCardRow;
  frame: Frame;
  media: CardFirstMedia;
}

/** The first photo or video in the post's platform frame. */
function CardMedia(props: CardMediaProps): ReactElement {
  return props.media.kind === 'video' ? <CardVideo {...props} /> : <CardImage {...props} />;
}

/** A photo cover: the version itself, presigned lazily when scrolled into view. */
function CardImage(props: CardMediaProps): ReactElement {
  const thumb = useThumbnail<HTMLDivElement>({
    assetVersionId: props.media.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  const url = thumb.failed ? null : thumb.url;
  return (
    <CardMediaBox
      {...props}
      boxRef={thumb.ref}
      backdrop={url !== null ? <CoverImage src={url} /> : undefined}
    >
      {url !== null ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={thumb.onError}
          draggable={false}
          className={cn('relative', frameMediaClass(props.frame))}
        />
      ) : null}
    </CardMediaBox>
  );
}

/**
 * A video cover: its stored thumbnail rendition (the route FileTile uses), asked
 * for once near the viewport. A version with none (older uploads) or a broken
 * one falls back to the video itself at its first frame.
 */
function CardVideo(props: CardMediaProps): ReactElement {
  const { media, frame } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef);
  const stored = useStoredThumbnail(
    media.assetVersionId,
    sharedCardPresignCache(),
    PRESIGN_ENABLED && near,
  );
  // A broken image drops only that version's thumbnail, never a newer one's.
  const [failedVersion, setFailedVersion] = useState<string | null>(null);
  const cover = failedVersion === media.assetVersionId ? null : stored.url;
  const fallback = stored.missing || failedVersion === media.assetVersionId;
  return (
    <CardMediaBox
      {...props}
      boxRef={boxRef}
      backdrop={cover !== null ? <CoverImage src={cover} /> : undefined}
    >
      {cover !== null ? (
        <img
          data-card-video-thumb=""
          src={cover}
          alt=""
          onError={() => setFailedVersion(media.assetVersionId)}
          draggable={false}
          className={cn('relative', frameMediaClass(frame))}
        />
      ) : fallback ? (
        <CardVideoFrame assetVersionId={media.assetVersionId} frame={frame} />
      ) : null}
      <span
        data-card-play=""
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-overlay text-overlay-fg">
          <IconPlay size={ICON_SIZE.inline} />
        </span>
      </span>
    </CardMediaBox>
  );
}

/**
 * The presigned video URL with a media fragment of t=0.1, so WebKit paints a
 * frame instead of a blank box while preload stays metadata. Pure.
 */
export function firstFrameSrc(url: string): string {
  const src = new URL(url);
  src.hash = 't=0.1';
  return src.href;
}

/** A video with no stored thumbnail: the file itself, paused on its first frame. */
function CardVideoFrame(props: { assetVersionId: string; frame: Frame }): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  return (
    <span ref={thumb.ref} className="relative block h-full w-full">
      {thumb.url !== null && !thumb.failed ? (
        <video
          data-card-video=""
          src={firstFrameSrc(thumb.url)}
          preload="metadata"
          muted
          playsInline
          onError={thumb.onError}
          className={cn('pointer-events-none', frameMediaClass(props.frame))}
        />
      ) : null}
    </span>
  );
}

/** The cover again, cropped to fill, behind the frame for blurred bands. */
function CoverImage(props: { src: string }): ReactElement {
  return <img src={props.src} alt="" draggable={false} className="h-full w-full object-cover" />;
}

/**
 * The frame box, 240px wide and at most 320px tall (a tall frame narrows), with
 * its corner pills.
 */
function CardMediaBox(
  props: CardMediaProps & {
    boxRef: RefObject<HTMLDivElement>;
    backdrop: ReactNode;
    children: ReactNode;
  },
): ReactElement {
  const { post, frame } = props;
  const pills = mediaPills(post);
  return (
    <div
      ref={props.boxRef}
      data-card-media=""
      className="relative flex w-full justify-center bg-panel-3"
    >
      <PlatformFrame
        frame={frame}
        maxHeight={CHAT_CARD_FRAME_MAX_HEIGHT}
        bordered={false}
        backdrop={props.backdrop}
      >
        {props.children}
      </PlatformFrame>
      <span className={cn(MEDIA_PILL, 'absolute right-2 top-2')}>{formatLabel(post.format)}</span>
      {pills.slides !== null || pills.video !== null ? (
        <span className="absolute bottom-2 right-2 flex gap-1">
          {pills.video !== null ? (
            <span className={MEDIA_PILL}>
              <IconPlay size={12} />
              {pills.video}
            </span>
          ) : null}
          {pills.slides !== null ? <span className={MEDIA_PILL}>{pills.slides}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The reader's RLS hid this post (e.g. a client receiving a draft). Same box as a
 * visible card, but no thumbnail and no link; never probes why it is hidden.
 */
export function NotVisibleCard(): ReactElement {
  return (
    <div className={`${SHARED_CARD_BOX} bg-panel-2 text-fg-2`}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-base font-medium">{NOT_VISIBLE_TITLE}</span>
        <span className="truncate text-sm">{NOT_VISIBLE_BODY}</span>
      </span>
    </div>
  );
}
