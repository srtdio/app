// The chat home's media chip results (Photos, Videos, Files, Links, Voice
// notes), as WhatsApp lists them: the items themselves under month headers,
// not the messages. A chip tap paints the device-cached first page on the
// first frame; the network page then lands on the same DOM (React keys are the
// item keys, the root never changes), so nothing blinks or remounts. Photos
// and videos are a square grid (4 across, 6 from 1180px); files, links and
// voice notes are rows. Thumbnails come from the app's one PresignCache (the
// small copy first, kept on the device), asked for only near the viewport.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Avatar } from '@/components/ui/Avatar';
import { FileViewer, remoteFileSource } from '@/components/ui/FileViewer';
import { KindIcon, useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { NoResults } from '@/components/ui/NoResults';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { PressableRow } from '@/components/ui/PressableRow';
import { UnsafeLinkSheet } from '@/components/ui/UnsafeLinkSheet';
import {
  ICON_SIZE,
  IconAlertTriangle,
  IconArrowUpRight,
  IconChat,
  IconLink,
  IconPhoto,
  IconPlay,
} from '@/components/ui/icons';
import { useOptionalToast } from '@/components/ui/toast';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { Thumbnail } from '@/components/media/Thumbnail';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { VoiceNote } from '@/components/chat/VoiceNote';
import { SettleLanding } from '@/components/chat/SettleLanding';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { RESULT_LABEL, noCallout, searchRetryRow } from '@/components/chat/SearchResults';
import { cn } from '@/lib/cn';
import { Bone } from '@/lib/motion';
import { mark } from '@/lib/perf-marks';
import { env } from '@/lib/env';
import { humanizeSize } from '@/lib/assets';
import { appPresignCache } from '@/lib/shared-presign';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { formatAgo } from '@/lib/time';
import { checkLink } from '@/lib/links/safety';
import { previewClient, type LinkPreview } from '@/lib/links/preview';
import { useInView } from '@/lib/use-in-view';
import { classifyFileKind } from '@/lib/chat/attachments';
import { thumbnailKind } from '@/lib/files/thumbnail';
import { VIEWER_NAME_BUDGET, fileKindLabel, middleTruncate } from '@/lib/files/display-name';
import type { ChannelSummary } from '@/lib/chat-reads';
import { chatDisplayName } from '@/lib/chat/chat-name';
import { OWN_PREFIX, type PreviewNameOf } from '@/lib/chat/chat-store';
import { APP_ENTITY_ROUTES, classify, currentOrigin, displayUrl } from '@/lib/chat/message-links';
import { isFileRemoved, removedFilesStore } from '@/lib/chat/remove-files';
import { useHiddenIds, withoutHidden } from '@/lib/chat/hides';
import {
  MEDIA_MIN_TILES,
  flattenHits,
  formatDurationMs,
  groupByMonth,
  isLinkItem,
  type ChipItem,
  type LinkItem,
  type MediaCacheValue,
  type MediaItem,
} from '@/lib/chat/media-items';
import {
  IDLE_SEARCH,
  normalizeQuery,
  searchDateLabel,
  searchReady,
  type SearchKind,
  type SearchRunner,
  type SearchState,
} from '@/lib/chat/search';

export interface MediaResultsProps {
  /** The chip that is on. */
  kind: SearchKind;
  /** The text in the search box ('' lists the chip alone). */
  query: string;
  state: SearchState;
  runner: SearchRunner | null;
  /** The device-cached first page for this chip; painted only while the query is ''. */
  cached: MediaCacheValue | undefined;
  /** Every chat in the roster (hidden included), for sender names and photos. */
  channelsById: ReadonlyMap<string, ChannelSummary>;
  currentUserId: string | null;
  /** Names already loaded (group senders, mentions). */
  nameOf: PreviewNameOf;
  nowMs: number;
  /** For tests: the zone dates render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** Clears the search box and the chip (NoResults' button). */
  onClear: () => void;
  /** Opens the chat at that message. The viewer closes first. */
  onShowInChat: (channelId: string, messageId: string) => void;
}

/** Thumbnails presign only with the asset-read Worker configured. */
const PRESIGN_ENABLED = env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

/** Loading boxes: one screen of tiles, or a few rows. */
const LOADING_TILES = 12;
const LOADING_ROWS = 3;

/** The square grid: 4 across, 6 from 1180px, 2px gaps. */
const GRID = 'grid grid-cols-4 gap-0.5 min-[1180px]:grid-cols-6';

/** A list row: one 64px tap target, no text selection and no iOS callout on hold. */
const ROW = cn('flex min-h-16 min-w-0 items-center gap-3 px-2 py-2', NO_TOUCH_SELECT);

/** The 44px leading box of a file or link row (the chat info Files and Links rows). */
const ROW_ICON =
  'relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-2 text-fg-3 lit-media';

/** A row's date: right, mono, meta ink. */
const ROW_DATE = 'shrink-0 font-mono text-sm tabular-nums text-fg-3';

/** The sender's display name: "You", a loaded name, the DM peer's chat name, else ''. Pure. */
export function mediaSenderName(
  item: Pick<ChipItem, 'senderId' | 'channelId'>,
  input: {
    currentUserId: string | null;
    nameOf: PreviewNameOf;
    channelsById: ReadonlyMap<string, ChannelSummary>;
  },
): string {
  const { senderId } = item;
  if (senderId === null) return '';
  if (senderId === input.currentUserId) return OWN_PREFIX;
  const known = input.nameOf(senderId);
  if (known !== undefined && known !== '') return known;
  const channel = input.channelsById.get(item.channelId);
  if (channel?.channelType === 'dm' && channel.peerUserId === senderId) {
    return chatDisplayName(channel);
  }
  return '';
}

/** "4 pages · 1.2 MB · PDF": pages only when known. Pure. */
export function mediaFileMeta(item: Pick<MediaItem, 'pageCount' | 'size' | 'mime'>): Array<{
  text: string;
  mono: boolean;
}> {
  const parts: Array<{ text: string; mono: boolean }> = [];
  if (item.pageCount !== null && item.pageCount > 0) {
    parts.push({ text: item.pageCount === 1 ? '1 page' : `${item.pageCount} pages`, mono: true });
  }
  if (item.size !== null && item.size > 0) {
    parts.push({ text: humanizeSize(item.size), mono: true });
  }
  parts.push({ text: fileKindLabel(item.mime), mono: false });
  return parts;
}

/** Where the items come from this render. Pure. */
export function mediaSource(input: {
  kind: SearchKind;
  query: string;
  state: SearchState;
  cached: MediaCacheValue | undefined;
}): 'network' | 'cache' | 'none' {
  const query = normalizeQuery(input.query);
  const current = input.state.query === query && input.state.kind === input.kind;
  if (current && input.state.status === 'ready') return 'network';
  if (input.cached !== undefined && input.cached.kind === input.kind && query === '') {
    return 'cache';
  }
  return 'none';
}

/** One photo tile: the small copy first (Thumbnail), a photo glyph without one. */
function PhotoTile(props: { item: MediaItem; onOpen: () => void }): ReactElement {
  const { item } = props;
  return (
    <PressableRow
      insetFocus
      type="button"
      flat
      data-media-tile={item.key}
      aria-label={item.name !== '' ? item.name : 'Photo'}
      onClick={props.onOpen}
      onContextMenu={noCallout}
      className={cn('relative block aspect-square overflow-hidden bg-panel-3', NO_TOUCH_SELECT)}
    >
      <span className="absolute inset-0">
        <Thumbnail
          assetVersionId={item.versionId}
          cache={appPresignCache()}
          presignEnabled={PRESIGN_ENABLED}
          fallback={{ kind: 'glyph' }}
          fallbackTile={
            <span className="text-fg-3">
              <IconPhoto size={ICON_SIZE.control} />
            </span>
          }
          alt={item.name}
        />
      </span>
    </PressableRow>
  );
}

/** One video tile: its stored thumbnail, the play glyph and the length bottom-left. */
function VideoTile(props: { item: MediaItem; onOpen: () => void }): ReactElement {
  const { item } = props;
  const cache = appPresignCache();
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(ref);
  const active = PRESIGN_ENABLED && item.versionId !== '';
  const stored = useStoredThumbnail(item.versionId, cache, active && near);
  // A thumbnail already known paints on the first frame (a peek is no request).
  const known = active ? (cache.peekThumbnail(item.versionId)?.url ?? null) : null;
  const [failed, setFailed] = useState(false);
  const url = failed ? null : (stored.url ?? known);
  return (
    <PressableRow
      insetFocus
      type="button"
      flat
      data-media-tile={item.key}
      aria-label={item.name !== '' ? item.name : 'Video'}
      onClick={props.onOpen}
      onContextMenu={noCallout}
      className={cn('relative block aspect-square overflow-hidden bg-panel-3', NO_TOUCH_SELECT)}
    >
      <span ref={ref} className="absolute inset-0">
        {url !== null ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
      </span>
      {url === null ? (
        <span className="absolute inset-0 flex items-center justify-center text-fg-3">
          <IconPlay size={ICON_SIZE.control} />
        </span>
      ) : null}
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-[color:var(--media-meta-bg)] px-1.5 py-px text-xs text-media-meta lit-media">
        <IconPlay size={ICON_SIZE.text} />
        {item.durationMs !== null ? (
          <span data-media-duration="" className="font-mono tabular-nums">
            {formatDurationMs(item.durationMs)}
          </span>
        ) : null}
      </span>
    </PressableRow>
  );
}

/** One file row: the stored thumbnail (PDF, video, Office) or the kind glyph, name, meta, date. */
function FileRowItem(props: { item: MediaItem; date: string; onOpen: () => void }): ReactElement {
  const { item } = props;
  const cache = appPresignCache();
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(ref);
  const wantsThumb = PRESIGN_ENABLED && item.versionId !== '' && thumbnailKind(item.mime) !== null;
  const stored = useStoredThumbnail(item.versionId, cache, wantsThumb && near);
  const known = wantsThumb ? (cache.peekThumbnail(item.versionId)?.url ?? null) : null;
  const [failed, setFailed] = useState(false);
  const thumb = wantsThumb && !failed ? (stored.url ?? known) : null;
  const name = item.name !== '' ? item.name : 'File';
  const kind = classifyFileKind(item.mime);
  return (
    <PressableRow
      type="button"
      data-media-row={item.key}
      onClick={props.onOpen}
      onContextMenu={noCallout}
      className={ROW}
    >
      <span ref={ref} className={ROW_ICON}>
        {thumb !== null ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <KindIcon kind={kind === 'video' ? 'video' : 'file'} size={ICON_SIZE.control} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          title={name}
          className="line-clamp-2 text-base font-medium text-fg [overflow-wrap:anywhere]"
        >
          {middleTruncate(name, VIEWER_NAME_BUDGET)}
        </span>
        <span className="truncate text-sm text-fg-3">
          {mediaFileMeta(item).map((part, i) => (
            <span key={`part-${i}`}>
              {i > 0 ? ' · ' : null}
              <span className={part.mono ? 'font-mono tabular-nums' : undefined}>{part.text}</span>
            </span>
          ))}
        </span>
      </span>
      <span className={ROW_DATE}>{props.date}</span>
    </PressableRow>
  );
}

/** The link's preview once known (in view only; the shared client caps requests at 4). */
function useLinkTitle(url: string, inView: boolean): LinkPreview | null {
  const client = previewClient();
  const [preview, setPreview] = useState<LinkPreview | null>(() => client.peek(url));
  useEffect(() => {
    if (preview !== null || !inView) return;
    const controller = new AbortController();
    client.request(url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, inView, preview, url]);
  return preview;
}

/** The host a url shows under its title. Pure. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return displayUrl(url);
  }
}

/** One link row: title (from its preview), domain, date. Tap opens; hold or right-click: menu. */
function LinkRowItem(props: {
  item: LinkItem;
  date: string;
  onShowInChat: () => void;
}): ReactElement {
  const { item } = props;
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const { ref, inView } = useInView<HTMLLIElement>();
  const preview = useLinkTitle(item.url, inView);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unsafeOpen, setUnsafeOpen] = useState(false);
  const externalRef = useRef<HTMLAnchorElement>(null);
  const target = classify(item.url, currentOrigin(), APP_ENTITY_ROUTES);
  const verdict = target.kind === 'external' ? checkLink(item.url) : null;
  const unsafe = verdict !== null && verdict.verdict === 'unsafe';
  const title =
    preview !== null && (preview.type === 'full' || preview.type === 'text') && preview.title !== ''
      ? preview.title
      : displayUrl(item.url);
  const domain =
    preview !== null && preview.type !== 'unsafe'
      ? (preview.finalDomain ?? preview.domain)
      : hostOf(item.url);

  const open = (): void => {
    // An unsafe link opens the check sheet, never the site.
    if (unsafe) setUnsafeOpen(true);
    else if (target.kind !== 'external') navigate(target.path);
    // External pages open like message-text links: a real anchor, new tab.
    else externalRef.current?.click();
  };
  const gesture = useMenuGesture(() => setMenuOpen(true));
  const items: ActionMenuItem[] = [
    { id: 'open', label: 'Open', icon: IconArrowUpRight, onSelect: open },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: IconLink,
      onSelect: () => {
        void copyText(item.url).then((ok) =>
          toast?.show(ok ? { title: 'Link copied' } : { title: COPY_FAILED, tone: 'error' }),
        );
      },
    },
    { id: 'show-in-chat', label: 'Show in chat', icon: IconChat, onSelect: props.onShowInChat },
  ];
  return (
    <li ref={ref} className="min-w-0">
      <PressableRow
        type="button"
        data-media-row={item.key}
        {...gesture.handlers}
        onClick={() => {
          if (gesture.consumeClickSuppression()) return;
          open();
        }}
        className={ROW}
      >
        <span className={cn(ROW_ICON, unsafe && 'bg-warn-soft text-warn-ink')}>
          {unsafe ? (
            <IconAlertTriangle size={ICON_SIZE.control} />
          ) : (
            <IconLink size={ICON_SIZE.control} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn('truncate text-base font-medium', unsafe ? 'text-warn-ink' : 'text-fg')}
          >
            {title}
          </span>
          <span className="truncate text-sm text-fg-3">{domain}</span>
        </span>
        <span className={ROW_DATE}>{props.date}</span>
      </PressableRow>
      {target.kind === 'external' && !unsafe ? (
        <a
          ref={externalRef}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
        />
      ) : null}
      <ActionMenu
        title={domain}
        items={items}
        trigger={null}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      />
      {unsafe && verdict !== null && verdict.verdict === 'unsafe' ? (
        <UnsafeLinkSheet
          open={unsafeOpen}
          url={item.url}
          reasons={verdict.reasons}
          onClose={() => setUnsafeOpen(false)}
        />
      ) : null}
    </li>
  );
}

/** One voice note row: the sender (photo and name through PersonTrigger), date, the player. */
function VoiceRowItem(props: {
  item: MediaItem;
  sender: string;
  avatarUrl: string | null;
  date: string;
}): ReactElement {
  const { item } = props;
  const cache = appPresignCache();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  // The note's link is asked for only near the viewport, through the shared cache.
  const { url, failed, peek, refresh } = useAttachmentUrl(
    item.versionId,
    cache,
    PRESIGN_ENABLED && near,
  );
  const name = props.sender !== '' ? props.sender : 'Voice note';
  return (
    <div
      ref={ref}
      data-media-row={item.key}
      className={cn('flex min-w-0 flex-col gap-1 px-2 py-2', NO_TOUCH_SELECT)}
      onContextMenu={noCallout}
    >
      <div className="flex min-h-11 min-w-0 items-center gap-3">
        {item.senderId !== null ? (
          <PersonTrigger
            display="block"
            className="shrink-0"
            userId={item.senderId}
            name={name}
            {...(props.avatarUrl !== null ? { avatarUrl: props.avatarUrl } : {})}
          >
            <Avatar
              name={name}
              {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
              role="row"
            />
          </PersonTrigger>
        ) : (
          <span className="flex shrink-0">
            <Avatar name={name} role="row" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">
          {item.senderId !== null ? (
            <PersonTrigger
              userId={item.senderId}
              name={name}
              {...(props.avatarUrl !== null ? { avatarUrl: props.avatarUrl } : {})}
            >
              {name}
            </PersonTrigger>
          ) : (
            name
          )}
        </span>
        <span className={ROW_DATE}>{props.date}</span>
      </div>
      <div className="pl-13">
        <VoiceNote
          url={PRESIGN_ENABLED && !failed ? url : null}
          name={item.name}
          mime={item.mime}
          durationMs={item.durationMs ?? undefined}
          messageId={item.messageId}
          {...(PRESIGN_ENABLED ? { peekUrl: peek, refreshUrl: refresh } : {})}
        />
      </div>
    </div>
  );
}

/** The month header: the section label role. */
function MonthLabel(props: { groupKey: string; label: string }): ReactElement {
  return (
    <h3 data-media-month={props.groupKey} className={cn(RESULT_LABEL, 'pt-3')}>
      {props.label}
    </h3>
  );
}

/**
 * The chip's results. Hooks only at the top; the item list is the network page
 * when it is current and ready, else the device cache (chip alone), else boxes.
 */
export function MediaResults(props: MediaResultsProps): ReactElement {
  const { kind, runner, nowMs, timeZone } = props;
  const query = normalizeQuery(props.query);
  // No runner (no workspace): nothing can be searched, so no boxes forever.
  const state: SearchState =
    runner === null ? { ...IDLE_SEARCH, query, kind, status: 'ready' } : props.state;

  // Files removed here behind the Undo window drop out at once.
  const [removedTick, bumpRemoved] = useReducer((n: number) => n + 1, 0);
  useEffect(() => removedFilesStore.subscribe(bumpRemoved), []);
  const isRemoved = useCallback(
    (channelId: string, messageId: string, versionId: string) =>
      isFileRemoved(removedFilesStore.get(channelId), messageId, versionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on each overlay change
    [removedTick],
  );
  const flatten = useCallback(
    (hits: SearchState['hits']) =>
      flattenHits(hits, kind, { appOrigin: currentOrigin(), routes: APP_ENTITY_ROUTES, isRemoved }),
    [kind, isRemoved],
  );

  const source = mediaSource({ kind, query, state, cached: props.cached });
  const networkItems = useMemo(
    () => (source === 'network' ? flatten(state.hits) : null),
    [source, flatten, state.hits],
  );
  const cachedItems = props.cached?.items;
  // Delete for me: hidden messages' items drop out at render (a Set lookup).
  const hiddenIds = useHiddenIds();
  const items: ChipItem[] | null = useMemo(() => {
    if (networkItems !== null) return withoutHidden(networkItems, hiddenIds, (i) => i.messageId);
    if (source === 'cache' && cachedItems !== undefined) {
      return withoutHidden(
        cachedItems.filter(
          (i) => isLinkItem(i) || !isRemoved(i.channelId, i.messageId, i.versionId),
        ),
        hiddenIds,
        (i) => i.messageId,
      );
    }
    return null;
  }, [networkItems, source, cachedItems, isRemoved, hiddenIds]);

  const current = state.query === query && state.kind === kind;
  const failed = current && state.status === 'error';
  // Past the server's 100 characters nothing is sent: no results.
  const sendable = searchReady(query, kind);
  const shown = useMemo<ChipItem[]>(() => items ?? [], [items]);
  const loading = items === null && !failed && sendable;
  const groups = useMemo(() => groupByMonth(shown, nowMs, timeZone), [shown, nowMs, timeZone]);

  // Paint marks, once per chip: from the device, then from the network.
  const markedRef = useRef<{ kind: SearchKind; cache: boolean; network: boolean }>({
    kind,
    cache: false,
    network: false,
  });
  useLayoutEffect(() => {
    if (markedRef.current.kind !== kind) {
      markedRef.current = { kind, cache: false, network: false };
    }
    const marked = markedRef.current;
    if (source === 'cache' && !marked.cache) {
      marked.cache = true;
      mark('chat:chip:painted');
    } else if (source === 'network' && !marked.network) {
      marked.network = true;
      mark('chat:chip:ready');
    }
  }, [kind, source]);

  // Next page as the end marker scrolls in (the SearchResults observer).
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasMore, loadingMore, moreFailed } = state;
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || runner === null || !hasMore || loadingMore || moreFailed) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void runner.loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [runner, hasMore, loadingMore, moreFailed, state.hits.length]);

  // A page that flattens to fewer than MEDIA_MIN_TILES items reads the next one
  // at once, once per page (a chip's hits are messages; a screen needs tiles).
  const settledRef = useRef<{ key: string; length: number }>({ key: '', length: 0 });
  useEffect(() => {
    if (runner === null || !current || state.status !== 'ready' || loadingMore || moreFailed) {
      return;
    }
    const key = `${kind}|${query}`;
    const settled = settledRef.current;
    const start = settled.key === key ? settled.length : 0;
    if (settled.key === key && state.hits.length <= start) return;
    settledRef.current = { key, length: state.hits.length };
    if (!hasMore) return;
    if (flatten(state.hits.slice(start)).length < MEDIA_MIN_TILES) void runner.loadMore();
  }, [
    runner,
    current,
    state.status,
    state.hits,
    loadingMore,
    moreFailed,
    hasMore,
    kind,
    query,
    flatten,
  ]);

  // The open viewer, by item key (stable when the cache swaps to the network page).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const onRetry = useCallback(() => runner?.retry(), [runner]);

  const names = {
    currentUserId: props.currentUserId,
    nameOf: props.nameOf,
    channelsById: props.channelsById,
  };
  const dateOf = (item: ChipItem): string => searchDateLabel(item.createdAt, nowMs);
  const sentAtLabel = (item: ChipItem): string =>
    formatAgo(item.createdAt, new Date(nowMs), timeZone);
  const showInChat = (item: ChipItem): void => {
    setOpenKey(null);
    props.onShowInChat(item.channelId, item.messageId);
  };

  const media = shown.filter((i): i is MediaItem => !isLinkItem(i));
  const photos = kind === 'photo' ? media : [];
  const photoIndex = openKey === null ? -1 : photos.findIndex((p) => p.key === openKey);
  const viewerItem =
    kind === 'video' || kind === 'file' ? (media.find((m) => m.key === openKey) ?? null) : null;

  // One source per open file: a new one each render would reload the viewer.
  const viewerVersion = viewerItem?.versionId ?? null;
  const viewerSource = useMemo(
    () =>
      viewerVersion !== null && PRESIGN_ENABLED
        ? remoteFileSource(appPresignCache(), viewerVersion)
        : null,
    [viewerVersion],
  );

  const grid = kind === 'photo' || kind === 'video';

  const body = loading ? (
    grid ? (
      <ul data-media-skeleton="" className={GRID}>
        {Array.from({ length: LOADING_TILES }, (_, i) => (
          <li key={`bone-${i}`} className="aspect-square">
            <Bone lit="lit-media" as="div" className="h-full w-full" />
          </li>
        ))}
      </ul>
    ) : (
      <ul data-media-skeleton="" className="flex flex-col">
        {Array.from({ length: LOADING_ROWS }, (_, i) => (
          <li key={`bone-${i}`} className="flex items-center gap-3 px-2 py-2">
            <Bone lit="lit-media" as="div" className="h-11 w-11 shrink-0 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone lit="flat" as="div" className="h-3 w-1/3 rounded" />
              <Bone lit="flat" as="div" className="h-3 w-3/4 rounded" />
            </div>
          </li>
        ))}
      </ul>
    )
  ) : failed && shown.length === 0 ? (
    <ul className="flex flex-col">{searchRetryRow(onRetry)}</ul>
  ) : shown.length === 0 ? (
    <div data-search-empty="">
      <NoResults query={query} filtersActive onClear={props.onClear} />
    </div>
  ) : (
    groups.map((group) => (
      <section key={group.key} data-media-group={group.key} className="flex flex-col gap-1">
        <MonthLabel groupKey={group.key} label={group.label} />
        <ul className={grid ? GRID : 'flex flex-col'}>
          {group.items.map((item) => {
            if (isLinkItem(item)) {
              return (
                <LinkRowItem
                  key={item.key}
                  item={item}
                  date={dateOf(item)}
                  onShowInChat={() => showInChat(item)}
                />
              );
            }
            if (kind === 'photo') {
              return (
                <li key={item.key} className="min-w-0">
                  <PhotoTile item={item} onOpen={() => setOpenKey(item.key)} />
                </li>
              );
            }
            if (kind === 'video') {
              return (
                <li key={item.key} className="min-w-0">
                  <VideoTile item={item} onOpen={() => setOpenKey(item.key)} />
                </li>
              );
            }
            if (kind === 'voice') {
              const channel = props.channelsById.get(item.channelId);
              const avatarUrl =
                channel?.channelType === 'dm' && channel.peerUserId === item.senderId
                  ? channel.avatarUrl
                  : null;
              return (
                <li key={item.key} className="min-w-0">
                  <VoiceRowItem
                    item={item}
                    sender={mediaSenderName(item, names)}
                    avatarUrl={avatarUrl}
                    date={dateOf(item)}
                  />
                </li>
              );
            }
            return (
              <li key={item.key} className="min-w-0">
                <FileRowItem item={item} date={dateOf(item)} onOpen={() => setOpenKey(item.key)} />
              </li>
            );
          })}
        </ul>
      </section>
    ))
  );

  return (
    <div data-media-results={kind} className="flex flex-col gap-2 px-4 pb-4">
      <SettleLanding boxes={loading} selector="[data-media-tile], [data-media-row]">
        {body}
      </SettleLanding>
      {!loading && shown.length > 0 ? (
        <ul className="flex flex-col">
          {loadingMore ? (
            <li data-search-more="" className="px-2 py-3">
              <Bone lit="flat" as="div" className="mx-auto h-3 w-1/3 rounded" />
            </li>
          ) : null}
          {moreFailed || failed ? searchRetryRow(onRetry) : null}
        </ul>
      ) : null}
      {!loading && !failed && hasMore ? (
        <div ref={sentinelRef} data-search-sentinel="" aria-hidden="true" className="h-px" />
      ) : null}
      {photoIndex !== -1 ? (
        <ImageLightbox
          images={photos.map((p) => ({ assetId: p.versionId, name: p.name }))}
          index={photoIndex}
          cache={appPresignCache()}
          presignEnabled={PRESIGN_ENABLED}
          details={{
            sender: mediaSenderName(photos[photoIndex] as MediaItem, names),
            time: sentAtLabel(photos[photoIndex] as MediaItem),
          }}
          onIndexChange={(i) => setOpenKey(photos[i]?.key ?? null)}
          onClose={() => setOpenKey(null)}
          onShowInChat={(i) => {
            const item = photos[i];
            if (item !== undefined) showInChat(item);
          }}
        />
      ) : null}
      {viewerItem !== null && viewerSource !== null ? (
        <FileViewer
          name={viewerItem.name !== '' ? viewerItem.name : 'File'}
          kind={classifyFileKind(viewerItem.mime)}
          size={viewerItem.size ?? undefined}
          source={viewerSource}
          sender={mediaSenderName(viewerItem, names)}
          sentAt={viewerItem.createdAt}
          onShowInChat={() => showInChat(viewerItem)}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </div>
  );
}
