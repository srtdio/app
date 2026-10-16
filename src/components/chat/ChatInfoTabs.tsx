// The chat info tabs: Media, Files, Links, Starred and Marks for one channel,
// DM or group. Media and Files share ONE attachments read per page (split
// client-side, voice notes in neither); Links is one read per page; Starred is
// the viewer's starred messages in this chat (StarredList, read the first time
// the tab opens, no Edit here); Marks is the pin board list MarksSheet renders. A tab's first page loads the first
// time it is shown and shows its loading state until that page resolves (first
// paint is final), then "Load more" reads the next keyset page while a page
// comes back full. Presigns go through the thread's PresignCache; sender names
// come from the profiles map, and senders missing from it are read in ONE
// batched readProfiles call per page (never per row). In 'preview' mode each
// tab shows its first few items and a "See all" row that expands that tab in
// place. No motion; colours are tokens only, so light and dark match.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  IconAlertTriangle,
  IconBookmark,
  IconFile,
  IconImage,
  IconLink,
  IconStar,
} from '@/components/ui/icons';
import { UnsafeLinkText } from '@/components/ui/UnsafeLinkSheet';
import { checkLink } from '@/lib/links/safety';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { FileViewer, remoteFileSource } from '@/components/ui/FileViewer';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { MarksList, type MarksListProps } from '@/components/chat/MarksSheet';
import { StarredList } from '@/components/chat/StarredList';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/assets';
import { supabase } from '@/lib/supabase';
import { readProfiles, type ChannelSummary, type ChatProfile } from '@/lib/chat-reads';
import type { PresignCache } from '@/lib/asset-presign';
import type { Result } from '@srtdio/rpc';
import type { MessageCursor } from '@/lib/chat/thread';
import { formatClockTime, formatShortDate } from '@/lib/chat/time-format';
import { classifyFileKind } from '@/lib/chat/attachments';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import { APP_ENTITY_ROUTES, currentOrigin, displayUrl } from '@/lib/chat/message-links';
import {
  listChannelAttachments,
  listChannelLinks,
  splitMediaFiles,
  type ChannelAttachmentItem,
  type ChannelLinkItem,
  type ChannelPage,
} from '@/lib/chat/channel-media';

export type ContactTab = 'media' | 'files' | 'links' | 'starred' | 'marks';

/** 'full' is the DM Contact page; 'preview' caps each tab until its See all. */
export type ChatInfoMode = 'full' | 'preview';

export const CONTACT_TABS: ReadonlyArray<{ key: ContactTab; label: string }> = [
  { key: 'media', label: 'Media' },
  { key: 'files', label: 'Files' },
  { key: 'links', label: 'Links' },
  { key: 'starred', label: 'Starred' },
  { key: 'marks', label: 'Marks' },
];

export const CONTACT_EMPTY: Record<Exclude<ContactTab, 'marks'>, string> = {
  media: 'No photos yet',
  files: 'No files yet',
  links: 'No links yet',
  starred: 'No starred messages',
};

/** How many items each tab shows in preview mode before See all. */
export const PREVIEW_COUNT: Readonly<Record<ContactTab, number>> = {
  media: 6,
  files: 3,
  links: 3,
  starred: 3,
  marks: 3,
};

export const SEE_ALL_LABEL = 'See all';

/** A capped preview tab with nothing loaded yet but an older page that may hold some. */
export const NOTHING_RECENT = 'Nothing recent';

/** The longest a sender-name read may take before the names stay "Unknown". */
export const SENDER_READ_TIMEOUT_MS = 5000;

/** One tab's paged list. `loading` holds until the first page resolves. */
export interface Feed<T> {
  status: 'loading' | 'ready' | 'error';
  items: T[];
  hasMore: boolean;
  cursor: MessageCursor | null;
  loadingMore: boolean;
}

export const FEED_LOADING: Feed<never> = {
  status: 'loading',
  items: [],
  hasMore: false,
  cursor: null,
  loadingMore: false,
};

/** Append a resolved page to a feed (the first page replaces the loading state). Pure. */
export function appendPage<T>(feed: Feed<T>, page: ChannelPage<T>): Feed<T> {
  return {
    status: 'ready',
    items: [...feed.items, ...page.items],
    hasMore: page.hasMore,
    cursor: page.cursor ?? feed.cursor,
    loadingMore: false,
  };
}

/** "Load more" shows only once the list is final and the last page came back full. */
export function showLoadMore(feed: Feed<unknown>): boolean {
  return feed.status === 'ready' && feed.hasMore;
}

/** Which feed a tab reads: Media and Files share the attachments read. */
export function feedForTab(tab: ContactTab): 'attachments' | 'links' | null {
  return tab === 'media' || tab === 'files' ? 'attachments' : tab === 'links' ? 'links' : null;
}

/**
 * The items a tab shows and whether it offers See all. `limit` null (full mode,
 * or a tab already expanded) shows everything. A capped tab offers See all when
 * it holds more than the cap, or when an older page may exist. Pure.
 */
export function previewOf<T>(
  items: readonly T[],
  hasMore: boolean,
  limit: number | null,
): { shown: readonly T[]; seeAll: boolean } {
  if (limit === null) return { shown: items, seeAll: false };
  return { shown: items.slice(0, limit), seeAll: items.length > limit || hasMore };
}

/** A tab's preview cap: null in full mode or once that tab's See all was tapped. Pure. */
export function previewLimit(
  mode: ChatInfoMode,
  tab: ContactTab,
  expanded: ReadonlySet<ContactTab>,
): number | null {
  return mode === 'preview' && !expanded.has(tab) ? PREVIEW_COUNT[tab] : null;
}

/** "You" for the viewer, the profile name otherwise; never a user read. */
export function contactSenderName(
  userId: string | null,
  currentUserId: string,
  profiles: Map<string, ChatProfile>,
): string {
  if (userId !== null && userId === currentUserId) return 'You';
  return (userId !== null ? profiles.get(userId)?.displayName : undefined) ?? 'Unknown';
}

/** The distinct sender ids of a page that are not yet known, in first-seen order. Pure. */
export function missingSenderIds(
  senderIds: ReadonlyArray<string | null>,
  known: (userId: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const id of senderIds) {
    if (id !== null && !known(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

type ProfileRead = (userIds: string[], signal: AbortSignal) => Promise<Result<ChatProfile[]>>;

/**
 * One batched profile read for `userIds`, bounded by `timeoutMs`: a timeout
 * aborts the read. A failure, a throw or a timeout yields an empty map, so the
 * names stay "Unknown". Never throws.
 */
export async function readSenderProfiles(
  userIds: string[],
  read: ProfileRead,
  timeoutMs: number = SENDER_READ_TIMEOUT_MS,
): Promise<Map<string, ChatProfile>> {
  const found = new Map<string, ChatProfile>();
  if (userIds.length === 0) return found;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([read(userIds, controller.signal), timeout]);
    if (result !== null && result.ok) {
      for (const profile of result.data) found.set(profile.userId, profile);
    }
  } catch {
    // A thrown read is a failed read: the names stay "Unknown".
  } finally {
    clearTimeout(timer);
  }
  return found;
}

/**
 * Resolve a loaded page's unknown senders: at most ONE read per page, only for
 * ids that are neither known nor asked before. An id is asked once for the
 * resolver's life, so a failed or timed-out read is never retried.
 */
export function senderNameResolver(input: {
  read: ProfileRead;
  known: (userId: string) => boolean;
  onResolved: (profiles: Map<string, ChatProfile>) => void;
  timeoutMs?: number;
}): (senderIds: ReadonlyArray<string | null>) => Promise<void> {
  const asked = new Set<string>();
  return async (senderIds) => {
    const ids = missingSenderIds(senderIds, (id) => asked.has(id) || input.known(id));
    if (ids.length === 0) return;
    for (const id of ids) asked.add(id);
    const found = await readSenderProfiles(ids, input.read, input.timeoutMs);
    if (found.size > 0) input.onResolved(found);
  };
}

/**
 * One paged feed: nothing is read until `active` first turns true, then one
 * read per page. A stale response (the sheet re-keyed meanwhile) is dropped.
 * `onPage` sees each resolved page's items.
 */
function useFeed<T>(
  active: boolean,
  load: (before?: MessageCursor) => Promise<Result<ChannelPage<T>>>,
  onPage: (items: T[]) => void,
): { feed: Feed<T> | null; loadMore: () => void; retry: () => void } {
  const [feed, setFeed] = useState<Feed<T> | null>(null);
  const live = useRef(true);
  const onPageRef = useRef(onPage);
  useEffect(() => {
    onPageRef.current = onPage;
  }, [onPage]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    (base: Feed<T>, before?: MessageCursor) => {
      void load(before).then((result) => {
        if (!live.current) return;
        setFeed(
          result.ok
            ? appendPage(base, result.data)
            : base.status === 'ready'
              ? { ...base, loadingMore: false }
              : { ...FEED_LOADING, status: 'error' },
        );
        if (result.ok) onPageRef.current(result.data.items);
      });
    },
    [load],
  );

  useEffect(() => {
    if (!active || feed !== null) return;
    setFeed(FEED_LOADING);
    run(FEED_LOADING);
  }, [active, feed, run]);

  const loadMore = useCallback(() => {
    if (feed === null || !showLoadMore(feed) || feed.loadingMore || feed.cursor === null) return;
    const base = { ...feed, loadingMore: true };
    setFeed(base);
    run(base, feed.cursor);
  }, [feed, run]);

  const retry = useCallback(() => setFeed(null), []);
  return { feed, loadMore, retry };
}

/** One Media tile: square, bg-panel-3 until the presigned image lands. */
function MediaTile(props: {
  item: ChannelAttachmentItem;
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: () => void;
}): ReactElement {
  const { url } = useAttachmentUrl(props.item.versionId, props.cache, props.presignEnabled);
  return (
    <button
      type="button"
      aria-label={props.item.name !== '' ? props.item.name : 'Photo'}
      onClick={props.onOpen}
      className="relative block aspect-square min-h-[44px] w-full cursor-zoom-in overflow-hidden bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {url !== null ? (
        <img
          src={url}
          alt={props.item.name}
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </button>
  );
}

const ROW =
  'flex min-h-[64px] w-full items-center gap-3 border-b border-border py-2 last:border-b-0';
const ROW_ICON =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-panel-2 text-fg-3';

/** "size · date" under a file name. Pure. */
export function fileMetaLine(item: ChannelAttachmentItem, timeZone: string): string {
  return `${humanizeSize(item.size)} · ${formatShortDate(item.createdAt, timeZone)}`;
}

/**
 * One Files row: a button that opens the file in the in-app FileViewer (pdf
 * pages, the video player, or "Preview not available yet" with Download),
 * never a new tab. The viewer reads fresh bytes or a fresh link on each open.
 */
function FileRow(props: {
  item: ChannelAttachmentItem;
  cache: PresignCache;
  presignEnabled: boolean;
  timeZone: string;
}): ReactElement {
  const { item, cache, presignEnabled } = props;
  const [open, setOpen] = useState(false);
  const name = item.name !== '' ? item.name : 'File';
  const source = useMemo(
    () => (presignEnabled ? remoteFileSource(cache, item.versionId) : null),
    [presignEnabled, cache, item.versionId],
  );
  return (
    <li>
      <button
        type="button"
        data-file-row={classifyFileKind(item.mime)}
        disabled={source === null}
        onClick={() => setOpen(true)}
        className={cn(ROW, 'rounded-md text-left hover:bg-panel-2 disabled:opacity-60')}
      >
        <span className={ROW_ICON}>
          <IconFile size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span title={name} className="truncate text-sm font-medium text-fg">
            {middleTruncate(name, VIEWER_NAME_BUDGET)}
          </span>
          <span className="truncate text-xs text-fg-2">{fileMetaLine(item, props.timeZone)}</span>
        </span>
      </button>
      {open && source !== null ? (
        <FileViewer
          name={name}
          kind={classifyFileKind(item.mime)}
          size={item.size ?? undefined}
          source={source}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </li>
  );
}

/** One Links row. Hook-free. */
export function LinkRow(props: {
  item: ChannelLinkItem;
  sender: string;
  date: string;
}): ReactElement {
  // An unsafe link opens the check sheet here too, never the site directly.
  const verdict = checkLink(props.item.url);
  if (verdict.verdict === 'unsafe') {
    return (
      <li>
        <UnsafeLinkText
          url={props.item.url}
          reasons={verdict.reasons}
          className={cn(ROW, 'w-full rounded-md text-left hover:bg-panel-2')}
        >
          <span className={cn(ROW_ICON, 'text-[color:var(--warn-ink)]')}>
            <IconAlertTriangle size={20} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-[color:var(--warn-ink)]">
              {displayUrl(props.item.url)}
            </span>
            <span className="truncate text-xs text-fg-2">{`${props.sender} · ${props.date}`}</span>
          </span>
        </UnsafeLinkText>
      </li>
    );
  }
  return (
    <li>
      <a
        href={props.item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(ROW, 'rounded-md text-left hover:bg-panel-2')}
      >
        <span className={ROW_ICON}>
          <IconLink size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-accent">
            {displayUrl(props.item.url)}
          </span>
          <span className="truncate text-xs text-fg-2">{`${props.sender} · ${props.date}`}</span>
        </span>
      </a>
    </li>
  );
}

/** The 48px full-width row that expands a previewed tab in place. Hook-free. */
export function SeeAllRow(props: { onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      data-see-all=""
      onClick={props.onClick}
      className="flex min-h-[48px] w-full items-center justify-center rounded-md border border-border bg-panel text-sm font-medium text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {SEE_ALL_LABEL}
    </button>
  );
}

/**
 * The first page's loading or error state, or the body once it resolved, plus
 * a 44px "Load more" when the last page came back full. A capped preview tab
 * passes `seeAll` instead: it never pages, and shows See all when `show`; when
 * it is empty but an older page may exist it reads "Nothing recent" above See
 * all rather than a blank area. Hook-free.
 */
export function FeedBody<T>(props: {
  feed: Feed<T> | null;
  empty: ReactElement;
  isEmpty: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  seeAll?: { show: boolean; onClick: () => void };
  children: ReactNode;
}): ReactElement {
  const { feed } = props;
  if (feed === null || feed.status === 'loading') {
    return (
      <p data-feed="loading" className="py-10 text-center text-sm text-fg-3">
        Loading
      </p>
    );
  }
  if (feed.status === 'error') {
    return (
      <div data-feed="error" className="flex flex-col items-center gap-2 py-10 text-sm text-fg-3">
        <span>Could not load</span>
        <Button size="lg" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  const more =
    props.seeAll !== undefined ? (
      props.seeAll.show ? (
        <SeeAllRow onClick={props.seeAll.onClick} />
      ) : null
    ) : showLoadMore(feed) ? (
      <Button
        size="lg"
        data-load-more=""
        className="w-full"
        disabled={feed.loadingMore}
        onClick={props.onLoadMore}
      >
        Load more
      </Button>
    ) : null;
  return (
    <div data-feed="ready" className="flex flex-col gap-3">
      {props.isEmpty && !feed.hasMore ? (
        props.empty
      ) : props.isEmpty && props.seeAll !== undefined ? (
        <p data-nothing-recent="" className="py-6 text-center text-sm text-fg-3">
          {NOTHING_RECENT}
        </p>
      ) : (
        props.children
      )}
      {more}
    </div>
  );
}

export interface ChatInfoTabsViewProps {
  tab: ContactTab;
  onTab: (tab: ContactTab) => void;
  /** Media and Files share the attachments feed; null until first shown. */
  attachments: Feed<ChannelAttachmentItem> | null;
  links: Feed<ChannelLinkItem> | null;
  onLoadMore: (feed: 'attachments' | 'links') => void;
  onRetry: (feed: 'attachments' | 'links') => void;
  cache: PresignCache;
  presignEnabled: boolean;
  timeZone: string;
  senderName: (userId: string | null) => string;
  onOpenImage: (index: number) => void;
  /**
   * The Starred tab's list (built by ChatInfoTabs only while that tab shows,
   * so its first page is read when the tab opens); absent reads empty.
   */
  starred?: ReactNode;
  /** Marks tab props, or null when the thread has no marks wiring. */
  marks: Omit<MarksListProps, 'open' | 'onJump'> | null;
  /** The surface showing the tabs is open (gates the Marks list's reads). */
  open: boolean;
  onJump: (messageId: string) => void;
  mode: ChatInfoMode;
  /** Preview tabs whose See all was tapped; ignored in full mode. */
  expanded?: ReadonlySet<ContactTab>;
  onSeeAll?: (tab: ContactTab) => void;
}

const NONE_EXPANDED: ReadonlySet<ContactTab> = new Set();
const NO_SEE_ALL = (): void => undefined;

/** The chips and the selected tab's body. Hook-free so tests walk it directly. */
export function ChatInfoTabsView(props: ChatInfoTabsViewProps): ReactElement {
  const expanded = props.expanded ?? NONE_EXPANDED;
  const onSeeAll = props.onSeeAll ?? NO_SEE_ALL;
  const limit = previewLimit(props.mode, props.tab, expanded);
  const split = splitMediaFiles(props.attachments?.items ?? []);
  const feedProps = (kind: 'attachments' | 'links', seeAll: boolean) => ({
    onLoadMore: () => props.onLoadMore(kind),
    onRetry: () => props.onRetry(kind),
    ...(limit !== null ? { seeAll: { show: seeAll, onClick: () => onSeeAll(props.tab) } } : {}),
  });
  let body: ReactElement;
  if (props.tab === 'media') {
    const view = previewOf(split.images, props.attachments?.hasMore ?? false, limit);
    body = (
      <FeedBody
        feed={props.attachments}
        isEmpty={split.images.length === 0}
        empty={<EmptyState icon={<IconImage size={22} />} title={CONTACT_EMPTY.media} />}
        {...feedProps('attachments', view.seeAll)}
      >
        <div data-media-grid="" className="grid grid-cols-3 gap-[2px]">
          {view.shown.map((item, index) => (
            <MediaTile
              key={`${item.messageId}-${item.versionId}`}
              item={item}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              onOpen={() => props.onOpenImage(index)}
            />
          ))}
        </div>
      </FeedBody>
    );
  } else if (props.tab === 'files') {
    const view = previewOf(split.files, props.attachments?.hasMore ?? false, limit);
    body = (
      <FeedBody
        feed={props.attachments}
        isEmpty={split.files.length === 0}
        empty={<EmptyState icon={<IconFile size={22} />} title={CONTACT_EMPTY.files} />}
        {...feedProps('attachments', view.seeAll)}
      >
        <ul data-files="" className="flex flex-col">
          {view.shown.map((item) => (
            <FileRow
              key={`${item.messageId}-${item.versionId}`}
              item={item}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              timeZone={props.timeZone}
            />
          ))}
        </ul>
      </FeedBody>
    );
  } else if (props.tab === 'links') {
    const items = props.links?.items ?? [];
    const view = previewOf(items, props.links?.hasMore ?? false, limit);
    body = (
      <FeedBody
        feed={props.links}
        isEmpty={items.length === 0}
        empty={<EmptyState icon={<IconLink size={22} />} title={CONTACT_EMPTY.links} />}
        {...feedProps('links', view.seeAll)}
      >
        <ul data-links="" className="flex flex-col">
          {view.shown.map((item, index) => (
            <LinkRow
              key={`${item.messageId}-${index}`}
              item={item}
              sender={props.senderName(item.senderUserId)}
              date={formatShortDate(item.createdAt, props.timeZone)}
            />
          ))}
        </ul>
      </FeedBody>
    );
  } else if (props.tab === 'starred') {
    body = (
      <div data-starred-tab="">
        {props.starred ?? (
          <EmptyState icon={<IconStar size={22} />} title={CONTACT_EMPTY.starred} />
        )}
      </div>
    );
  } else {
    body =
      props.marks !== null ? (
        <MarksList
          {...props.marks}
          open={props.open}
          onJump={props.onJump}
          {...(limit !== null
            ? { preview: { rows: limit, seeAll: <SeeAllRow onClick={() => onSeeAll('marks')} /> } }
            : {})}
        />
      ) : (
        <EmptyState icon={<IconBookmark size={22} />} title="Nothing here" />
      );
  }

  return (
    <>
      <div className="flex flex-wrap gap-2" role="tablist">
        {CONTACT_TABS.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            size="tap"
            selected={props.tab === option.key}
            onClick={() => props.onTab(option.key)}
          />
        ))}
      </div>
      <div data-contact-tab={props.tab}>{body}</div>
    </>
  );
}

export interface ChatInfoTabsProps {
  channelId: string;
  profiles: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  cache: PresignCache;
  presignEnabled: boolean;
  marks: Omit<MarksListProps, 'open' | 'onJump'> | null;
  onJump: (messageId: string) => void;
  mode: ChatInfoMode;
  /**
   * The surface is showing (default true). While false nothing is read or
   * rendered, but the tab, feeds and names are kept for the next open.
   */
  open?: boolean;
  /** Wraps the tabs in the host's page; the lightbox stays outside it. */
  frame?: (tabs: ReactElement) => ReactElement;
  /** Escape while open and no lightbox is up (the lightbox owns Escape then). */
  onEscape?: () => void;
}

const NO_FRAME = (tabs: ReactElement): ReactElement => tabs;

const NO_CHANNELS: ReadonlyMap<string, ChannelSummary> = new Map();

/**
 * The Starred tab's list: this chat's stars, no "› Chat", no Edit. Preview
 * mode (Group info) caps it at PREVIEW_COUNT.starred rows with See all until
 * that is tapped; full mode (the DM Contact sheet) lists them all. Pure.
 */
export function starredTab(input: {
  mode: ChatInfoMode;
  expanded: ReadonlySet<ContactTab>;
  channelId: string;
  profiles: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  onJump: (messageId: string) => void;
  onSeeAll: () => void;
}): ReactElement {
  const limit = previewLimit(input.mode, 'starred', input.expanded);
  return (
    <StarredList
      channelId={input.channelId}
      showChat={false}
      channelsById={NO_CHANNELS}
      profiles={input.profiles}
      currentUserId={input.currentUserId}
      timeZone={input.timeZone}
      onOpen={(row) => input.onJump(row.id)}
      {...(limit !== null
        ? { preview: { rows: limit, seeAll: <SeeAllRow onClick={input.onSeeAll} /> } }
        : {})}
    />
  );
}

/**
 * The stateful tabs: the selected tab, each tab's See-all state, the two
 * feeds, the batched sender names and the Media lightbox. Key it by channel.
 */
export function ChatInfoTabs(props: ChatInfoTabsProps): ReactElement {
  const open = props.open ?? true;
  const frame = props.frame ?? NO_FRAME;
  const [tab, setTab] = useState<ContactTab>('media');
  const [expanded, setExpanded] = useState<ReadonlySet<ContactTab>>(NONE_EXPANDED);
  const [viewer, setViewer] = useState<number | null>(null);
  const [names, setNames] = useState<Map<string, ChatProfile>>(() => new Map());
  const { channelId, profiles, currentUserId } = props;

  // What the resolver may skip: the viewer and anyone the profiles map holds.
  const knownRef = useRef<(userId: string) => boolean>(() => false);
  useEffect(() => {
    knownRef.current = (userId) => userId === currentUserId || profiles.has(userId);
  }, [currentUserId, profiles]);
  const [resolveSenders] = useState(() =>
    senderNameResolver({
      read: (userIds, signal) => readProfiles(supabase, userIds, signal),
      known: (userId) => knownRef.current(userId),
      onResolved: (found) =>
        setNames((prev) => {
          const next = new Map(prev);
          for (const [id, profile] of found) next.set(id, profile);
          return next;
        }),
    }),
  );
  const onPage = useCallback(
    (items: ReadonlyArray<{ senderUserId: string | null }>) =>
      void resolveSenders(items.map((item) => item.senderUserId)),
    [resolveSenders],
  );

  const loadAttachments = useCallback(
    (before?: MessageCursor) =>
      listChannelAttachments(supabase, { channelId, ...(before !== undefined ? { before } : {}) }),
    [channelId],
  );
  const loadLinks = useCallback(
    (before?: MessageCursor) =>
      listChannelLinks(supabase, {
        channelId,
        appOrigin: currentOrigin(),
        routes: APP_ENTITY_ROUTES,
        ...(before !== undefined ? { before } : {}),
      }),
    [channelId],
  );
  const shown = open ? feedForTab(tab) : null;
  const attachments = useFeed(shown === 'attachments', loadAttachments, onPage);
  const links = useFeed(shown === 'links', loadLinks, onPage);

  const known = useMemo(() => {
    const merged = new Map(names);
    for (const [id, profile] of profiles) merged.set(id, profile);
    return merged;
  }, [names, profiles]);
  const senderName = useCallback(
    (userId: string | null) => contactSenderName(userId, currentUserId, known),
    [currentUserId, known],
  );

  const images = splitMediaFiles(attachments.feed?.items ?? []).images;
  const current = viewer !== null ? images[Math.min(viewer, images.length - 1)] : undefined;

  const { onEscape } = props;
  useEffect(() => {
    if (!open || viewer !== null || onEscape === undefined) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onEscape?.();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, viewer, onEscape]);

  // The Starred tab mounts its list only while it shows: its first page is
  // read when the tab opens. No Edit here; a row closes the surface and jumps.
  const starred =
    open && tab === 'starred'
      ? starredTab({
          mode: props.mode,
          expanded,
          channelId,
          profiles: known,
          currentUserId,
          timeZone: props.timeZone,
          onJump: props.onJump,
          onSeeAll: () => setExpanded((prev) => new Set(prev).add('starred')),
        })
      : null;

  const tabs = (
    <ChatInfoTabsView
      tab={tab}
      starred={starred}
      onTab={setTab}
      attachments={attachments.feed}
      links={links.feed}
      onLoadMore={(kind) => (kind === 'attachments' ? attachments.loadMore() : links.loadMore())}
      onRetry={(kind) => (kind === 'attachments' ? attachments.retry() : links.retry())}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      timeZone={props.timeZone}
      senderName={senderName}
      onOpenImage={setViewer}
      marks={props.marks}
      open={open}
      onJump={props.onJump}
      mode={props.mode}
      expanded={expanded}
      onSeeAll={(key) => setExpanded((prev) => new Set(prev).add(key))}
    />
  );

  return (
    <>
      {open ? frame(tabs) : null}
      {open && viewer !== null && current !== undefined ? (
        <ImageLightbox
          images={images.map((item) => ({ assetId: item.versionId, name: item.name }))}
          index={Math.min(viewer, images.length - 1)}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
          details={{
            sender: senderName(current.senderUserId),
            time: formatClockTime(current.createdAt, props.timeZone),
          }}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
}
