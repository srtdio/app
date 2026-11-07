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

import { Bone, rememberCard } from '@/lib/motion';
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
  ComponentType,
  CSSProperties,
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
import { ICON_SIZE, IconCheck, IconPipeline, IconPlay } from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { ChatCard, type ChatCardRootProps } from '@/components/ui/ChatCard';
import { useLongPress } from '@/components/ui';
import { LONG_PRESS_MS, MOVE_CANCEL_PX } from '@/components/ui/useLongPress';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import { frameMediaClass, PlatformFrame } from '@/components/media/PlatformFrame';
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
import { formatDueDate, formatAgo } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  cardMediaHeight,
  cardTextLines,
  chatCardFrame,
  postCardHeight,
} from '@/components/chat/post-card-geometry';
import { POST_CARD_META_TYPE, useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
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
interface PostCardBatch {
  posts: PostCardRow[];
  names: Map<string, string>;
  roles: Map<string, string>;
}

/**
 * The approver role read is capped inside the names read's own 5s budget, so a
 * hung role read degrades to "name only" instead of taking the names down too.
 */
const APPROVER_ROLE_CAP_MS = READ_TIMEOUT_MS - 1_000;

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
function threadCardReaders(
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
function createThreadCardCache(client: Client, workspaceId: string): ThreadCardCache {
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
interface CardRetryTargets {
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
/** A post card's own failure line; Retry beside it re-runs the read. */
export const POST_LOAD_FAILED = "Couldn't load this post.";

/** A failed card's second line, under "Couldn't load". */
export const CARD_LOAD_FAILED_HINT = 'Tap to try again';

/**
 * A card whose reads failed every try: ui/ChatCard (the card is the bubble)
 * with its kind glyph, "Couldn't load" over the hint; its one 44px tap
 * re-reads it. `className` sets a fixed height to match its card's own box
 * (the brief card); `cardMeta` is the message's time and tick (last card).
 */
export function CouldntLoadCard(props: {
  onRetry: () => void;
  icon: ComponentType<IconProps>;
  className?: string;
  cardMeta?: ReactNode;
}): ReactElement {
  return (
    <ChatCard
      icon={props.icon}
      title={CARD_LOAD_FAILED}
      meta={
        <span className={CARD_META_ROW}>
          <span className="truncate text-sm text-fg-2">{CARD_LOAD_FAILED_HINT}</span>
        </span>
      }
      onOpen={props.onRetry}
      time={props.cardMeta}
      rootProps={{ 'data-card-failed': '' }}
      {...(props.className !== undefined ? { className: props.className } : {})}
    />
  );
}

/**
 * A message's card group: under the bubble's other content (inBubble: text,
 * files, a quote above it), or alone, where each card is the bubble itself.
 */
export function cardGroupClass(inBubble: boolean): string {
  return cn('flex flex-col items-start text-fg', inBubble ? 'mt-2 gap-2' : 'gap-1');
}

/** What a thread hands a message's cards: where they sit, and the time for the last one. */
export interface CardPlacement {
  /** The cards sit under other bubble content; false: each card is the bubble (default true). */
  inBubble?: boolean | undefined;
  /** The message's time and tick, drawn bottom-trailing inside its last card. */
  cardMeta?: ReactNode;
}

/** The card meta for item `index` of `count`: only the last card carries it. */
export function metaForLast(index: number, count: number, cardMeta: ReactNode): ReactNode {
  return index === count - 1 ? cardMeta : undefined;
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
interface CardRefActions {
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
  inBubble = true,
  cardMeta,
}: {
  postIds: string[];
  /** The card message's id, handed to onTalkAbout. */
  messageId?: string;
  onTalkAbout?: ((postId: string, messageId: string) => void) | undefined;
  onTalkAboutFocus?: (() => void) | undefined;
} & CardPlacement): ReactElement | null {
  const { workspaceId, workspaces, workspaceName } = useWorkspace();
  const { side, ready, known } = useSettledViewerSide(workspaceId);
  // Due dates are calendar days on the workspace zone (src/lib/time.ts).
  const workspaceZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? null;
  // One workspace = one platform: every card's media box takes its frame, read
  // from the listed workspace row in this same render (no effect, no read), so
  // the box is final on the first frame.
  const platform = workspaces.find((w) => w.id === workspaceId)?.platform ?? null;
  const { views, loading, failed, cache } = useSharedPosts(postIds);
  const retryInView = useRetryInView(cache, { postIds }, loading);
  if (postIds.length === 0) return null;
  if (loading || !ready) {
    return (
      <div ref={retryInView} className={cardGroupClass(inBubble)}>
        {postIds.map((id, i) => (
          <PostCardSkeleton
            key={id}
            platform={platform}
            cardMeta={metaForLast(i, postIds.length, cardMeta)}
          />
        ))}
      </div>
    );
  }
  return (
    <SharedPostCardList
      inBubble={inBubble}
      cardMeta={cardMeta}
      views={views}
      platform={platform}
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
 * name read failed) reads "Approved · 3h" / "Approved · Mon" (formatAgo) from
 * approved_at, never a blank name. Other footers pass through. Pure.
 */
export function approvedWithoutName<F extends { state: string }>(
  footer: F,
  post: Pick<PostCardRow, 'stage' | 'approved_at'>,
  approverName: string | null,
  now: Date = new Date(),
): F {
  if (post.stage !== 'approved' || approverName !== null || post.approved_at === null) {
    return footer;
  }
  const at = formatAgo(post.approved_at, now);
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
  /**
   * The workspace's platform: every card's media box takes its frame. Absent
   * (tests): each card's own post platform, the same value in the app.
   */
  platform?: string | null | undefined;
}

/** The resolved cards in postIds order (presentational; no reads). */
export function SharedPostCardList(
  props: {
    views: SharedPostView[];
    /** Ids whose reads failed every try: "Couldn't load" in their place. */
    failed?: readonly string[];
    onRetry?: (postIds: string[]) => void;
  } & CardContext &
    CardRefActions &
    CardPlacement,
): ReactElement {
  const {
    views,
    onTalkAbout,
    onTalkAboutFocus,
    failed = [],
    onRetry,
    inBubble = true,
    cardMeta,
    ...context
  } = props;
  const failedIds = new Set(failed);
  return (
    <div data-induction={INDUCTION_KEYS.chatPostCard} className={cardGroupClass(inBubble)}>
      {views.map((view, i) => {
        const meta = metaForLast(i, views.length, cardMeta);
        return failedIds.has(view.postId) ? (
          <PostCouldntLoadCard
            key={view.postId}
            platform={context.platform ?? null}
            onRetry={() => onRetry?.([view.postId])}
            cardMeta={meta}
          />
        ) : view.kind === 'not_visible' ? (
          <NotVisibleCard key={view.postId} platform={context.platform ?? null} cardMeta={meta} />
        ) : (
          <PostCardItem
            key={view.postId}
            view={view}
            {...context}
            cardMeta={meta}
            {...(onTalkAbout !== undefined ? { onTalkAbout: () => onTalkAbout(view.postId) } : {})}
            {...(onTalkAboutFocus !== undefined ? { onTalkAboutFocus } : {})}
          />
        );
      })}
    </div>
  );
}

/**
 * The card's line 2: the stage Tag's height, never taller (h-5,
 * CARD_META_ROW_PX), in every state, so each state is the same box.
 */
const CARD_META_ROW = 'flex h-5 min-w-0 items-center gap-2 overflow-hidden';

/**
 * Every card state's outer height: ChatCard's rows around the platform frame's
 * media box. Each state renders the same rows, so this is also what they
 * measure; kept for the geometry tests and the thread's height reasoning. Pure.
 */
export function cardBoxStyle(
  platform: string | null,
  layout: ChatLayout,
  withMeta = false,
): CSSProperties {
  return { height: postCardHeight(chatCardFrame(platform), layout, withMeta) };
}

/**
 * The media box slot (the card's preview): the platform frame's fixed height
 * on a neutral fill, so it is the same box with no cover, before a cover
 * lands, and while loading. A picture inset inside the card (rounded-inset).
 */
function CardMediaSlot(props: {
  platform: string | null;
  boxRef?: RefObject<HTMLDivElement>;
  children?: ReactNode;
}): ReactElement {
  return (
    <div
      ref={props.boxRef}
      data-card-media=""
      style={{ height: cardMediaHeight(chatCardFrame(props.platform)) }}
      className="relative flex w-full shrink-0 justify-center overflow-hidden rounded-inset bg-panel-3"
    >
      {props.children}
    </div>
  );
}

/** An action row's 44 placeholder (no words yet, or none for this state). */
function FooterSpace(): ReactElement {
  return <span aria-hidden="true" className="h-11" />;
}

/**
 * A post card's placeholder: ui/ChatCard with the card's own rows (bones for
 * the title and the meta row, the workspace platform's media box, the 44
 * action row), so the card fills in place and never moves a row. No reads.
 */
export function PostCardSkeleton(props: {
  platform: string | null;
  cardMeta?: ReactNode;
}): ReactElement {
  return (
    <ChatCard
      icon={IconPipeline}
      title={<Bone lit="flat" as="span" className="h-5 w-40 rounded" />}
      meta={
        <span className={CARD_META_ROW}>
          <Bone lit="flat" as="span" className="h-5 w-16 rounded" />
        </span>
      }
      preview={<CardMediaSlot platform={props.platform} />}
      primaryAction={<FooterSpace />}
      time={props.cardMeta}
      rootProps={{ 'aria-hidden': true, 'data-card-skeleton': '' }}
    />
  );
}

/** A small pill laid over the cover image. */
const MEDIA_PILL =
  'inline-flex h-5 items-center gap-1 rounded-lg bg-panel px-1.5 text-xs font-medium text-fg lit-media';

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

/** A card's hold: LONG_PRESS_MS still within MOVE_CANCEL_PX, the bubble's long-press defaults. */
export const CARD_HOLD = { thresholdMs: LONG_PRESS_MS, moveTolerancePx: MOVE_CANCEL_PX } as const;

/** A card hold's Talk about, remembered until the finger lifts. */
interface TalkAboutHold {
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

/**
 * Whether a pointerleave on the card ends its press: only the pressing
 * pointer's own leave does (no press yet: any leave). Pure.
 */
export function leaveEndsPress(pressId: number | null, leaveId: number): boolean {
  return pressId === null || pressId === leaveId;
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

function PostCardItem(
  props: { view: Extract<SharedPostView, { kind: 'post' }> } & CardContext & {
      onTalkAbout?: () => void;
      onTalkAboutFocus?: () => void;
      cardMeta?: ReactNode;
    },
): ReactElement {
  const { view, side, timeZone } = props;
  const { post } = view;
  const nowMs = useMinuteClock();
  const now = new Date(nowMs);
  const approver = approverLabel(view.approverName, view.approverRole, props.brand ?? null);
  const footer = approvedWithoutName(cardFooter(post, approver, side, now), post, approver, now);
  const target =
    post.target_date !== null ? formatDueDate(post.target_date, props.workspaceZone) : '';
  // The media box is the workspace platform's frame, whatever the post holds:
  // the box never changes shape when its cover lands.
  const platform = props.platform !== undefined ? props.platform : post.platform;
  const boxFrame = chatCardFrame(platform);
  // A format with no media box of its own (text, link, a thread with no media)
  // shows its text inside the box; a media format shows its first photo or
  // video there, or the neutral box when it has none.
  const textOnly = cardFrame(post) === null;
  const media = textOnly ? null : post.firstMedia;
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
  // The press's pointer id: only that pointer leaving ends the press.
  const pressId = useRef<number | null>(null);
  const hold = useLongPress(() => {
    onTalkAbout?.();
    const now = holdFocusesOnFire({ layout, pointerType: pressPointer.current });
    talk.held(now ? props.onTalkAboutFocus : undefined);
  }, CARD_HOLD);
  // A touch hold also fires contextmenu (Android): the hold is the card's, so
  // the bubble's action menu stays shut. A mouse right-click still reaches it.
  const touchPress = useRef(false);
  // growFromCard: the tapped card is remembered (by post id) so the post page,
  // opened from its sheet, grows out of it (docs/motion.md).
  const cardRef = useRef<HTMLDivElement>(null);
  const tap = cardTapHandlers(() => {
    rememberCard(post.id, cardRef.current);
    setSheetMounted(true);
    setSheetOpen(true);
  }, hold.consumeClickSuppression);
  const press: ChatCardRootProps = {
    ref: cardRef,
    role: 'button',
    tabIndex: 0,
    'data-msg-link': '',
    'aria-haspopup': 'dialog',
    'aria-label': `Open post ${post.title}`,
    ...(onTalkAbout !== undefined
      ? {
          ...hold.handlers,
          onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            touchPress.current = e.pointerType !== 'mouse';
            pressPointer.current = e.pointerType;
            pressId.current = e.pointerId;
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
          // Released off the card: that press never focuses later. Only the
          // pressing pointer counts: WebKit sends the mouse cursor's leave
          // when the thread scrolls under it (Talk about re-pins the
          // thread), which must not end a touch hold.
          onPointerLeave: (e: PointerEvent<HTMLDivElement>) => {
            if (leaveEndsPress(pressId.current, e.pointerId)) talk.reset();
          },
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
      : {}),
    onClick: tap.onClick,
    onKeyDown: tap.onKeyDown,
  };
  // The footer row is always there (its 44px are the box's); its words only
  // once the viewer's side is known, never a wording that flips.
  const known = props.sideKnown !== false;
  return (
    <>
      {/* ui/ChatCard: the card is the bubble and one press target as a whole
          (tap opens the sheet, a hold talks about the post; role="button"
          takes the card's hover and focus line). */}
      <ChatCard
        icon={IconPipeline}
        title={
          <span data-card-title="" title={post.title}>
            {post.title}
          </span>
        }
        meta={
          <span className={cn(CARD_META_ROW, 'text-fg-3', POST_CARD_META_TYPE)}>
            <Tag
              label={stageLabel(post.stage)}
              {...(isTagDot(post.stage) ? { dot: post.stage } : {})}
            />
            {target !== '' ? <span data-card-target="">{target}</span> : null}
          </span>
        }
        preview={
          textOnly ? (
            <CardText platform={platform} text={cardText(post)} />
          ) : media !== null ? (
            <CardMedia post={post} platform={platform} frame={boxFrame} media={media} />
          ) : (
            <CardMediaSlot platform={platform}>
              <CardPills post={post} />
            </CardMediaSlot>
          )
        }
        secondaryAction={
          known ? (
            <span
              data-card-footer=""
              className={cn(
                'flex min-w-0 items-center gap-1 text-sm',
                footer.accent ? 'font-medium text-accent' : 'text-fg-2',
              )}
            >
              {footer.check ? (
                <IconCheck size={ICON_SIZE.inline} className="shrink-0 text-good" />
              ) : null}
              <span className="truncate">{footer.state}</span>
            </span>
          ) : undefined
        }
        primaryAction={
          known ? (
            <span className="shrink-0 text-sm font-medium text-accent">{footer.action}</span>
          ) : (
            <FooterSpace />
          )
        }
        time={props.cardMeta}
        rootProps={press}
      />
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
  /** The workspace platform: the media box's fixed frame. */
  platform: string | null;
  /** chatCardFrame(platform): the frame the first media is fit into. */
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
      painted={url !== null}
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
      painted={cover !== null || fallback}
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
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-overlay text-overlay-fg lit-media">
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
 * The media slot with the frame inside it, at the slot's fixed height (a tall
 * frame narrows), and its corner pills. Until there is media to draw the frame
 * is the neutral token surface (no bands), so only its fill changes on load.
 */
function CardMediaBox(
  props: CardMediaProps & {
    boxRef: RefObject<HTMLDivElement>;
    backdrop: ReactNode;
    /** There is media to draw (a cover URL, or the video's own frame). */
    painted: boolean;
    children: ReactNode;
  },
): ReactElement {
  const { post, frame } = props;
  return (
    <CardMediaSlot platform={props.platform} boxRef={props.boxRef}>
      <PlatformFrame
        frame={props.painted ? frame : { ...frame, bands: 'none' }}
        maxHeight={`${cardMediaHeight(frame)}px`}
        bordered={false}
        backdrop={props.backdrop}
      >
        {props.children}
      </PlatformFrame>
      <CardPills post={post} />
    </CardMediaSlot>
  );
}

/** The format pill (top right) and the video and slide pills (bottom right). */
function CardPills(props: { post: PostCardRow }): ReactElement {
  const { post } = props;
  const pills = mediaPills(post);
  return (
    <>
      <span className={cn(MEDIA_PILL, 'absolute right-2 top-2')}>{formatLabel(post.format)}</span>
      {pills.slides !== null || pills.video !== null ? (
        <span className="absolute bottom-2 right-2 flex gap-1">
          {pills.video !== null ? (
            <span className={MEDIA_PILL}>
              <IconPlay size={ICON_SIZE.text} />
              {pills.video}
            </span>
          ) : null}
          {pills.slides !== null ? <span className={MEDIA_PILL}>{pills.slides}</span> : null}
        </span>
      ) : null}
    </>
  );
}

/** A text-only post's words: its caption, else its title. Pure. */
export function cardText(post: Pick<PostCardRow, 'title' | 'caption'>): string {
  const caption = post.caption?.trim() ?? '';
  return caption !== '' ? caption : post.title;
}

/**
 * A text-only post (text, link, a thread with no media): its words inside the
 * media box, in the platform's frame on a token surface, clamped to the lines
 * the box holds, so the box never collapses.
 */
function CardText(props: { platform: string | null; text: string }): ReactElement {
  const frame = chatCardFrame(props.platform);
  const clamp: CSSProperties = {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: cardTextLines(frame),
    overflow: 'hidden',
  };
  return (
    <CardMediaSlot platform={props.platform}>
      <PlatformFrame
        frame={{ ...frame, bands: 'none' }}
        maxHeight={`${cardMediaHeight(frame)}px`}
        bordered={false}
      >
        <span
          data-card-text=""
          style={clamp}
          className="whitespace-pre-line break-words p-3 text-base text-fg"
        >
          {props.text}
        </span>
      </PlatformFrame>
    </CardMediaSlot>
  );
}

/**
 * The reader's RLS hid this post (e.g. a client receiving a draft). The same
 * rows as a visible card (neutral media box, title, meta row, the empty 44
 * action row) on a muted ChatCard, but no thumbnail and no tap; never probes
 * why it is hidden.
 */
export function NotVisibleCard(props: {
  platform?: string | null;
  cardMeta?: ReactNode;
}): ReactElement {
  const platform = props.platform ?? null;
  return (
    <ChatCard
      icon={IconPipeline}
      title={<span data-card-title="">{NOT_VISIBLE_TITLE}</span>}
      meta={
        <span className={cn(CARD_META_ROW, 'text-sm text-fg-2')}>
          <span className="truncate">{NOT_VISIBLE_BODY}</span>
        </span>
      }
      preview={<CardMediaSlot platform={platform} />}
      primaryAction={<FooterSpace />}
      time={props.cardMeta}
      muted
      rootProps={{ 'data-card-not-visible': '' }}
    />
  );
}

/**
 * A post card whose reads failed every try: the same rows, "Couldn't load
 * this post." and a Retry in the action row that re-reads it.
 */
export function PostCouldntLoadCard(props: {
  platform: string | null;
  onRetry: () => void;
  cardMeta?: ReactNode;
}): ReactElement {
  return (
    <ChatCard
      icon={IconPipeline}
      title={<span data-card-title="">{POST_LOAD_FAILED}</span>}
      meta={<span className={CARD_META_ROW} />}
      preview={<CardMediaSlot platform={props.platform} />}
      primaryAction={
        <Button variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      }
      time={props.cardMeta}
      rootProps={{ 'data-card-failed': '' }}
    />
  );
}
