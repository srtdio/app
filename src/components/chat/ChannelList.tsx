import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { stripFormat } from '@srtdio/comments';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Row } from '@/components/ui/Row';
import { Tile } from '@/components/ui/Tile';
import { createPressIntent, type PressIntent } from '@/lib/chat/press-intent';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CountBadge, countBadgeText } from '@/components/ui/CountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { useLongPress } from '@/components/ui';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { Chip } from '@/components/ui/Chip';
import { ICON_SIZE, IconChat, IconCheckCircle, IconEyeOff, IconPlus } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';
import { Bone, BoxSkeleton, GlideItem } from '@/lib/motion';
import { SettleLanding } from '@/components/chat/SettleLanding';
import { useCoarsePointer, useHoverPointer } from '@/lib/use-is-laptop';
import { filterChannelsByName } from '@/lib/channel-filter';
import type { ChannelSummary } from '@/lib/chat-reads';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import {
  selectConversation,
  selectHidden,
  type ChatLoadStatus,
  type ConversationSummary,
} from '@/lib/chat/chat-store';
import { deleteChatFailedMessage, type ClearRunResult } from '@/lib/chat/clear-flow';
import { sortChannelsByRecency } from '@/lib/chat/sort-conversations';
import { formatChatTime } from '@/lib/time';
import { draftText, draftsVersion, subscribeDrafts } from '@/lib/chat/drafts';
import { mentionNamesIn, resolveMentionPreview, splitAllMentions } from '@/lib/chat/mentions';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { summaryIconOfLine } from '@/lib/chat/thread';
import { SummaryGlyph } from '@/components/chat/ReplyQuote';
import { SearchResults, useMessageSearch } from '@/components/chat/SearchResults';
import { MediaResults } from '@/components/chat/MediaResults';
import {
  flattenHits,
  isMediaCacheValue,
  mediaCacheWhat,
  type MediaCacheValue,
} from '@/lib/chat/media-items';
import { isFileRemoved, removedFilesStore } from '@/lib/chat/remove-files';
import { APP_ENTITY_ROUTES, currentOrigin } from '@/lib/chat/message-links';
import { peekKept, primeRead, readKey } from '@/lib/session-read';
import { mark } from '@/lib/perf-marks';
import { StarredList } from '@/components/chat/StarredList';
import { STARRED_TITLE } from '@/lib/chat/stars';
import {
  normalizeQuery,
  SEARCH_CHIPS,
  SEARCH_MIN_CHARS,
  SEARCH_PAGE_SIZE,
  type SearchHit,
  type SearchKind,
} from '@/lib/chat/search';
import { NOTES_TILE_LINE } from '@/lib/chat/notes';
import { chatDisplayName } from '@/lib/chat/chat-name';
import { NotesAvatar } from '@/components/chat/NotesBits';
import { useSession } from '@/lib/session-context';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import {
  DRAFT_PREFIX_TYPE,
  NO_TOUCH_SELECT,
  useChatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';

/** Per-channel draft text lookup ('' when the chat has no draft). */
type DraftLookup = (channelId: string) => string;

/** The label before a chat's unsent draft in its preview line. */
export const DRAFT_PREFIX = 'Draft: ';

/**
 * The draft a row previews: a chat's non-empty draft text, only while that chat
 * is not the one open (the open chat shows its draft in the composer). Pure.
 */
export function rowDraft(draft: string, open: boolean): string | null {
  return !open && draft.trim() !== '' ? draft : null;
}

/**
 * A stored draft as its list line: its @[uuid] tokens read "@Name" from this
 * workspace's registry only. Pure over the registry.
 */
export function draftLine(stored: string, workspaceId: string | null): string {
  return resolveMentionPreview(stripFormat(stored), mentionNamesIn(workspaceId));
}

/** A list line with each real "@all" token drawn bold (the ink stays the line's own). */
export function boldAllMentions(text: string): ReactNode {
  const runs = splitAllMentions(text);
  if (runs.every((run) => !run.all)) return text;
  return runs.map((run, i) =>
    run.all ? (
      <span key={i} data-mention-all="" className="font-semibold">
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/** Per-channel store lookup the cards read (preview, time, unread). */
type SummaryLookup = (channelId: string) => ConversationSummary | undefined;

/** Whether a channel is hidden (deleted for the caller, nothing newer since). */
type HiddenLookup = (channelId: string) => boolean;

/** Select mode (Apple Messages pattern): check chats, then delete them for me. */
export interface ChannelSelectMode {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  onStart: () => void;
  onCancel: () => void;
  onToggle: (channelId: string) => void;
  /** Opens the confirm for the checked chats. */
  onDelete: () => void;
}

interface ChannelListProps {
  channels: readonly ChannelSummary[];
  /**
   * The document scrolls the list (a phone, page mode, src/lib/scroll-mode.ts):
   * the list grows with its rows instead of scrolling inside a full-height
   * column, the header row pins below the sticky Topbar and the select bar to
   * the bottom above the tab bar. Absent or false: the full-height pane with
   * its own scroller, exactly as before (laptop, touch tablet).
   */
  pageScroll?: boolean;
  /**
   * The store's load status. Rows (and the empty state) render only when
   * 'ready'; 'loading' shows skeleton rows and 'error' the Retry state.
   */
  status: ChatLoadStatus;
  /** Re-run the failed load (the error state's Retry). */
  onRetry: () => void;
  selectedChannelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
  /**
   * A chat row was pressed (pointerdown, before its tap): the open's reads may
   * start now. Never selects; the tap (onSelect) still opens.
   */
  onPressIn?: (channel: ChannelSummary) => void;
  /** Opens the New chat sheet (header "+" and empty-state action). */
  onNewChat: () => void;
  /** For tests: the zone card times render in. The app passes none (the viewer's device zone). */
  timeZone?: string;
  /**
   * Delete chats for the caller only (sequential, stops at the first failure);
   * absent hides long-press delete and the Select control.
   */
  onDeleteChats?: (channels: ChannelSummary[]) => Promise<ClearRunResult<ChannelSummary>>;
  /** The open workspace: a Draft line resolves names from its registry only. */
  workspaceId?: string | null;
  /** A message search hit tapped: open that chat at that message, the bar on the query. */
  onOpenSearchHit?: (channel: ChannelSummary, messageId: string, query: string) => void;
  /** A starred row tapped: open that chat at that message (no search bar). */
  onOpenStarred?: (channel: ChannelSummary, messageId: string) => void;
  /**
   * The caller's Personal notes (built from the session, never read): its
   * tile is pinned above Groups from the first paint, and search hits in it
   * carry its name. Absent: no tile.
   */
  notes?: ChannelSummary;
  /** Rendered at the top of the home list (hidden while searching), e.g. the getting-started card. */
  lead?: ReactNode;
}

interface ChannelListBodyProps extends Omit<ChannelListProps, 'status' | 'onRetry'> {
  /** Whether any conversations exist before the search filter is applied. */
  hasChannels: boolean;
  /** The name search; the no-match line names it. */
  search?: string;
  /** Clears the name search (the no-match state's Clear search). */
  onClearSearch?: () => void;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels; defaults to 0 when no summary is supplied. */
  nowMs?: number;
  /** Present while select mode is on: rows show a leading check and tap toggles. */
  selecting?: { selectedIds: ReadonlySet<string>; onToggle: (channelId: string) => void };
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** A row was long-pressed (or right-clicked): open its menu at the row. */
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
  /** The chat whose row menu is open, or null. */
  menuOpenId?: string | null;
  /** The open row menu closed without a pick. */
  onMenuClose?: () => void;
  /** The row menu's Hide chat. */
  onHide?: (channel: ChannelSummary) => void;
  /** The list's input, read once per list (never per row); touch when absent. */
  input?: ChannelListInput;
}

/**
 * What the rows need to know about the input, read by ChannelList once (one
 * listener per list, not one per row) and handed to every row.
 */
export interface ChannelListInput {
  /** The size table (touch or laptop). */
  layout: ChatLayout;
  /** A fine hover pointer: the row's hover ⋯ shows. */
  hoverMenu: boolean;
  /** A touch-first pointer: long-press owns the row menu, contextmenu is suppressed. */
  coarsePointer: boolean;
}

/** Pure tests and first renders without a list: the touch table, no hover. */
export const DEFAULT_LIST_INPUT: ChannelListInput = {
  layout: 'touch',
  hoverMenu: false,
  coarsePointer: false,
};

/** The list's input: one layout listener and two pointer reads for the whole list. */
export function useChannelListInput(): ChannelListInput {
  const layout = useChatLayout();
  const hoverMenu = useHoverPointer();
  const coarsePointer = useCoarsePointer();
  return useMemo(() => ({ layout, hoverMenu, coarsePointer }), [layout, hoverMenu, coarsePointer]);
}

/**
 * The channel list body. Pure and exported so its three states are unit tested:
 * the zero-state when no conversations exist (the header's New chat is the
 * only create button), a
 * NoResults state when a search hides every conversation, and one row
 * per channel otherwise.
 */
export function channelListView(props: ChannelListBodyProps): ReactElement {
  if (!props.hasChannels) {
    return (
      <EmptyState
        icon={<IconChat size={ICON_SIZE.status} />}
        title="Chats with your team show up here."
      />
    );
  }
  if (props.channels.length === 0) {
    return (
      <NoResults
        query={props.search ?? ''}
        filtersActive={false}
        onClear={props.onClearSearch ?? (() => undefined)}
      />
    );
  }
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const nowMs = props.nowMs ?? 0;
  const timeZone = props.timeZone;
  // Group rows carry the induction key plus their channel id; the guide boxes the
  // row whose id is the default group's (attributes only).
  const groupAnchor = (channel: ChannelSummary) => ({
    'data-induction': INDUCTION_KEYS.chatDefaultGroupRow,
    'data-induction-channel': channel.channelId,
  });
  const { groups, people } = splitSections(props.channels);
  const renderCard = (
    channel: ChannelSummary,
    anchored: boolean,
    divider: boolean,
  ): ReactElement => (
    // Glide: a reorder (new message lifts a chat) moves rows to their new
    // place; group rows list on Y, the people grid on X+Y.
    <GlideItem
      as="li"
      axis={anchored ? 'y' : 'xy'}
      key={channel.channelId}
      className="min-w-0"
      {...(anchored ? groupAnchor(channel) : {})}
    >
      <ChannelCard
        channel={channel}
        selected={channel.channelId === props.selectedChannelId}
        summary={summaryFor(channel.channelId)}
        draft={rowDraft(
          props.draftFor?.(channel.channelId) ?? '',
          channel.channelId === props.selectedChannelId,
        )}
        nowMs={nowMs}
        timeZone={timeZone}
        onSelect={props.onSelect}
        divider={divider}
        {...(props.onPressIn !== undefined ? { onPressIn: props.onPressIn } : {})}
        input={props.input ?? DEFAULT_LIST_INPUT}
        {...(props.selecting !== undefined
          ? {
              checked: props.selecting.selectedIds.has(channel.channelId),
              onToggle: props.selecting.onToggle,
            }
          : {})}
        {...(props.onLongPress !== undefined
          ? {
              onLongPress: props.onLongPress,
              menuOpen: props.menuOpenId === channel.channelId,
              ...(props.onMenuClose !== undefined ? { onMenuClose: props.onMenuClose } : {}),
              ...(props.onHide !== undefined ? { onHide: props.onHide } : {}),
            }
          : {})}
      />
    </GlideItem>
  );
  return (
    <div data-chat-home="" className={CHAT_HOME_STACK}>
      {groups.length > 0 ? (
        <>
          <h3 data-section-label="groups" className={sectionLabelClass(true)}>
            Groups
          </h3>
          <ul data-section="groups" className={GROUP_ROW_LIST}>
            {groups.map((channel, i) => renderCard(channel, true, i < groups.length - 1))}
          </ul>
        </>
      ) : null}
      {people.length > 0 ? (
        <>
          <h3 data-section-label="people" className={sectionLabelClass(groups.length === 0)}>
            People
          </h3>
          <ul data-section="people" className={PEOPLE_TILE_GRID}>
            {people.map((channel) => renderCard(channel, false, false))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Skeleton tiles shown while the list loads; enough to fill a phone screen. */
export const SKELETON_ROWS = 6;

/** The skeleton's sections: two group rows, then four people tiles. */
const SKELETON_GROUPS = 2;
const SKELETON_PEOPLE = SKELETON_ROWS - SKELETON_GROUPS;

/** A label-sized placeholder bar on the label's own edge and padding. */
function skeletonLabel(first: boolean): ReactElement {
  return (
    <div className={cn('px-4', first ? 'pt-1' : 'pt-3')}>
      <Bone lit="flat" as="div" className="h-4 w-16 rounded" />
    </div>
  );
}

/**
 * The loading body: the real sections' shapes, drawn by the same parts (label,
 * group Rows 72 tall with a 32 avatar and two lines, label, a 2-column grid of
 * square Tiles with a caption), so swapping in the list shifts nothing. Each
 * box is a motion Bone (top-lit sweep, never a pulse); no spinner. Shown only
 * when the device holds no list (the store paints a saved list at once).
 */
export function channelListSkeleton(): ReactElement {
  return (
    <BoxSkeleton lit="flat" className={CHAT_HOME_STACK} label="Loading conversations">
      {skeletonLabel(true)}
      <ul className={GROUP_ROW_LIST}>
        {Array.from({ length: SKELETON_GROUPS }, (_, i) => (
          <li key={i} data-skeleton-row="row" className="min-w-0">
            <Row
              leading={<Bone lit="lit-avatar" as="span" className="h-8 w-8 rounded-lg" />}
              title={<Bone lit="flat" as="span" className="my-1 h-3 w-1/2 rounded" />}
              secondary={<Bone lit="flat" as="span" className="my-1 h-3 w-3/4 rounded" />}
              divider={i < SKELETON_GROUPS - 1}
            />
          </li>
        ))}
      </ul>
      {skeletonLabel(false)}
      <ul className={PEOPLE_TILE_GRID}>
        {Array.from({ length: SKELETON_PEOPLE }, (_, i) => (
          <li key={i} data-skeleton-row="tile" className="min-w-0">
            <Tile
              thumbnail={<Bone lit="lit-card" as="span" className="h-full w-full" />}
              title={<Bone lit="flat" as="span" className="my-1 h-3 w-2/3 rounded" />}
              meta={<Bone lit="flat" as="span" className="my-1 h-2 w-1/3 rounded" />}
            />
          </li>
        ))}
      </ul>
    </BoxSkeleton>
  );
}

/** The error body: the load failed, so no partial list; Retry re-runs it. */
export function channelListError(onRetry: () => void): ReactElement {
  return (
    <EmptyState
      icon={<IconChat size={ICON_SIZE.status} />}
      title="Couldn't load chats"
      action={
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

/**
 * Build the preview line: an optional sender prefix before the last message. A
 * channel whose last message is known only by time (outside the preview scan)
 * reads as an empty line rather than "No messages yet".
 */
export function previewLine(summary: ConversationSummary): string {
  if (summary.lastMessageText === '') return '';
  const prefix = summary.lastMessagePrefix !== undefined ? `${summary.lastMessagePrefix}: ` : '';
  return `${prefix}${stripFormat(summary.lastMessageText)}`;
}

/**
 * The tile's accessible name: the chat, its unread count, the preview (or
 * draft) and the time, so a screen reader hears what a sighted user sees.
 * "Open Priya, 3 unread, Draft: see you, 10:42". Pure.
 */
export function channelTileLabel(props: {
  title: string;
  unread: number;
  preview: string;
  time: string;
  draft?: string | null;
}): string {
  const parts = [`Open ${props.title}`];
  if (props.unread > 0) parts.push(`${props.unread} unread`);
  const draft = props.draft ?? null;
  const line = draft !== null ? `${DRAFT_PREFIX}${draft}` : props.preview;
  if (line !== '') parts.push(line);
  if (props.time !== '') parts.push(props.time);
  return parts.join(', ');
}

/** Shift+F10 or the ContextMenu key opens a focused row's menu (Enter still opens the chat). */
export function rowMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** A home tile's shape: a group channel is wide (Groups), a DM is square (People). */
export type TileKind = 'wide' | 'square';

/** The tile a channel renders as: group -> wide, DM -> square. Pure. */
export function tileKind(channel: Pick<ChannelSummary, 'channelType'>): TileKind {
  return channel.channelType === 'group' ? 'wide' : 'square';
}

/**
 * Split the (already recency-sorted, filtered) channels into the Groups and
 * People sections, keeping each section's order. Pure.
 */
export function splitSections<T extends Pick<ChannelSummary, 'channelType'>>(
  channels: readonly T[],
): { groups: T[]; people: T[] } {
  const groups: T[] = [];
  const people: T[] = [];
  for (const c of channels) (tileKind(c) === 'wide' ? groups : people).push(c);
  return { groups, people };
}

/** The unread pill's text, or null when there is nothing unread (no pill). Pure. */
export function unreadPillText(unread: number): string | null {
  return unread > 0 ? countBadgeText(unread) : null;
}

/**
 * The home stack inside the one scroll container, 8px between blocks. Rows
 * bleed to the pane's sides and draw their own 16 edge; labels and the people
 * grid sit on the same 16 edge (CHAT_HOME_EDGE), like the search box above.
 */
export const CHAT_HOME_STACK = 'flex flex-col gap-2';

/** The home's 16 edge for the parts that do not draw their own (labels, the grid). */
export const CHAT_HOME_EDGE = 'px-4';

/** Groups: one ui/Row per chat, stacked, a divider (inset 60) between rows. */
export const GROUP_ROW_LIST = 'flex flex-col';

/** People: two fluid columns of ui/Tile, 12 apart; an odd last cell stays empty. */
export const PEOPLE_TILE_GRID = cn('grid grid-cols-2 gap-3', CHAT_HOME_EDGE);

/** Section label: 12/600 uppercase, 0.06em tracking, secondary ink. */
export const SECTION_LABEL_TYPE = 'text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/**
 * The label's padding: 4px top for the first section, 12px after, on the
 * home's 16 edge (the row text and the grid start on it too).
 */
export function sectionLabelClass(first: boolean): string {
  return cn(SECTION_LABEL_TYPE, CHAT_HOME_EDGE, first ? 'pt-1' : 'pt-3');
}

/**
 * A group row's photo slot: the shared Avatar at its header role (32), group
 * kind (rounded square), in the Row's fixed 32 column, so the box is final on
 * first paint.
 */
export const GROUP_TILE_PHOTO = 'flex shrink-0';

/**
 * A person tile's thumbnail: the shared Avatar at its profile role (72 circle)
 * centred on the tile's lit square (radius 8 from ui/Tile).
 */
export const PERSON_TILE_PHOTO = 'flex h-full w-full items-center justify-center bg-panel lit-card';

/** Tile state that picks the tile's selected look. */
export interface ChannelRowState {
  /** Desktop: this chat is open in the thread pane. */
  selected: boolean;
  /** Select mode is on. */
  selecting: boolean;
  /** Select mode: this tile is checked. */
  checked: boolean;
}

/**
 * Whether the row or tile takes the one selected look (lit-selected): a
 * checked chat in select mode, or the chat open on desktop. Pure.
 */
export function channelRowSelected(state: ChannelRowState): boolean {
  return state.selecting ? state.checked : state.selected;
}

/**
 * The tile's contextmenu on a touch-first pointer: the native menu and callout
 * never show (the long-press opens the tile menu). A laptop's right-click is
 * left alone here. Pure.
 */
export function chatRowContextMenu(
  coarsePointer: boolean,
): ((event: { preventDefault: () => void }) => void) | undefined {
  return coarsePointer ? (event) => event.preventDefault() : undefined;
}

/** The unread count (the shared CountBadge), or nothing when the count is 0. */
function unreadPill(unread: number): ReactElement | null {
  return unreadPillText(unread) === null ? null : <CountBadge count={unread} />;
}

/** What a chat shows: the parts' slot contents, built once. Hook-free and pure. */
export interface ChannelRowParts {
  /** Group (a Row) or person (a Tile). */
  kind: TileKind;
  /** The chat's display name (chatDisplayName). */
  name: string;
  /** The last message time ('' when there is none). */
  time: string;
  /** The photo, in its slot (data-group-photo / data-person-photo). */
  photo: ReactElement;
  /** The group row's second line: the preview or "Draft: ..."; null for a person tile. */
  preview: ReactElement | null;
  /** The unread CountBadge, or null. */
  pill: ReactElement | null;
  /** The select-mode check, or null. */
  check: ReactElement | null;
}

/**
 * The slot contents of one chat. A group is a Row: 32 rounded-square photo,
 * name + time, a one-line preview (or "Draft: ..."), the unread badge on the
 * second line's end. A person is a Tile: the 72 disc on the tile square, the
 * name, the time in the meta slot (no preview line), the unread badge in the
 * top-right corner. The avatar URL is on the summary before the tile mounts
 * (one batched list read), so a photo paints first, never the initials.
 */
export function channelRowParts(props: {
  channel: ChannelSummary;
  summary: ConversationSummary | undefined;
  /** The chat's unsent draft (not open): the preview reads "Draft: <text>". */
  draft?: string | null;
  nowMs: number;
  timeZone?: string | undefined;
  selecting: boolean;
  checked: boolean;
}): ChannelRowParts {
  const { channel, summary } = props;
  const kind = tileKind(channel);
  const wide = kind === 'wide';
  const name = chatDisplayName(channel);
  const hasMessage = summary !== undefined && summary.lastMessageTs > 0;
  const unread = summary?.unread ?? 0;
  const previewText = hasMessage ? previewLine(summary) : 'No messages yet';
  // A media line ("Photo", "Voice message") leads with its glyph, as in the quote.
  const previewIcon = hasMessage ? summaryIconOfLine(summary.lastMessageText) : null;
  const draft = props.draft ?? null;
  const time = hasMessage
    ? formatChatTime(summary.lastMessageTs, new Date(props.nowMs), props.timeZone)
    : '';
  const preview = !wide ? null : draft !== null ? (
    <span data-draft-preview="">
      <span className={cn('text-accent', DRAFT_PREFIX_TYPE)}>{DRAFT_PREFIX}</span>
      {boldAllMentions(draft)}
    </span>
  ) : (
    <span {...(hasMessage ? {} : { className: 'text-fg-3' })}>
      {previewIcon !== null && hasMessage ? (
        <>
          {summary.lastMessagePrefix !== undefined ? `${summary.lastMessagePrefix}: ` : ''}
          <SummaryGlyph icon={previewIcon} className="mr-1" />
          {summary.lastMessageText}
        </>
      ) : (
        boldAllMentions(previewText)
      )}
    </span>
  );
  const avatar = (
    <Avatar
      name={name}
      {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
      role={wide ? 'header' : 'profile'}
      kind={wide ? 'group' : 'person'}
    />
  );
  // The photo is part of the tap surface: a tap on it opens the chat (or
  // toggles it while selecting). The enlarged photo lives only inside a DM.
  const photo = (
    <span
      {...(wide ? { 'data-group-photo': '' } : { 'data-person-photo': '' })}
      className={wide ? GROUP_TILE_PHOTO : PERSON_TILE_PHOTO}
    >
      {avatar}
    </span>
  );
  return {
    kind,
    name,
    time,
    photo,
    preview,
    pill: unreadPill(unread),
    check: props.selecting ? <SelectCheck checked={props.checked} /> : null,
  };
}

/** A tile corner's inset: the badge or check sits 8 inside the square's corner. */
const TILE_CORNER_INSET = 'flex p-2';

/**
 * The ⋯ opener for a chat (H5): always visible, the trigger of the same
 * ActionMenu a long-press opens. ActionMenuTrigger owns the trailing rule, so
 * its glyph's visible edge sits on the row's (or the tile's) content edge.
 * fg-3 at rest, full ink on hover, as before. Tokens only.
 */
export const ROW_MORE_INK = 'text-fg-3 hover:text-fg';

/** A chat row's menu rows: Hide chat (non-destructive: eye-off, never red; FT43). */
export function chatRowMenuItems(onHide: () => void): ActionMenuItem[] {
  return [{ id: 'hide', label: 'Hide chat', icon: IconEyeOff, onSelect: onHide }];
}

/**
 * One conversation: a group is a ui/Row, a person a ui/Tile; either way the
 * whole surface is one button ("Open <name>"). A touch long-press (moving or
 * scrolling cancels it), right-click, Shift+F10, or the always-visible ⋯ (the
 * row's trailing slot, the tile's title line) opens the chat menu; the
 * trailing click is swallowed so a long-press never also opens the chat. In
 * select mode a check shows and a tap toggles.
 */
export function ChannelCard(props: {
  channel: ChannelSummary;
  selected: boolean;
  summary: ConversationSummary | undefined;
  /** The chat's unsent draft when it is not open; null or absent shows the last message. */
  draft?: string | null;
  nowMs: number;
  timeZone?: string | undefined;
  onSelect: (channel: ChannelSummary) => void;
  /** A primary press on the tile (pointerdown), outside select mode: before the tap. */
  onPressIn?: (channel: ChannelSummary) => void;
  /** The list's input (hover, coarse), read once by the list. */
  input: ChannelListInput;
  /** A group row's divider (every row but the last in its section). */
  divider?: boolean;
  /** Present in select mode: whether this tile is checked. */
  checked?: boolean;
  onToggle?: (channelId: string) => void;
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
  /** This tile's menu is open (the list holds which one). */
  menuOpen?: boolean;
  onMenuClose?: () => void;
  /** The menu's Hide chat. */
  onHide?: (channel: ChannelSummary) => void;
}): ReactElement {
  const { channel, summary } = props;
  const rowRef = useRef<HTMLButtonElement>(null);
  const selecting = props.onToggle !== undefined;
  const { coarsePointer } = props.input;
  const menuEnabled = !selecting && props.onLongPress !== undefined;
  // This gesture's hold already opened the menu; reset on every pointerdown.
  const holdFiredRef = useRef(false);
  const openMenu = (anchor?: DOMRect): void => {
    if (selecting || props.onLongPress === undefined) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onLongPress(channel, anchor ?? rowRef.current?.getBoundingClientRect() ?? null);
  };
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => {
      holdFiredRef.current = true;
      openMenu();
    },
    { ignoreMouse: true },
  );
  const checked = props.checked === true;
  // Press-in: a press held still for PRESS_SETTLE_MS (a ceiling, never a wait
  // on the paint or the tap) starts the open's reads before the lift. A
  // scroll, a pan (pointercancel), a lift or a move past PRESS_SLOP_PX reads
  // nothing; only a pointerdown arms it, so mouse hover never reads.
  const onPressInRef = useRef(props.onPressIn);
  onPressInRef.current = props.onPressIn;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const pressRef = useRef<PressIntent | null>(null);
  pressRef.current ??= createPressIntent(() => onPressInRef.current?.(channelRef.current));
  const press = pressRef.current;
  useEffect(() => () => press.cancel(), [press]);
  const pressDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (selecting || props.onPressIn === undefined || !e.isPrimary || e.button !== 0) return;
    press.down(e);
  };
  const pressHandlers = {
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => press.move(e),
    onPointerUp: () => press.cancel(),
    onPointerCancel: () => press.cancel(),
  };
  const parts = channelRowParts({
    channel,
    summary,
    draft: props.draft ?? null,
    nowMs: props.nowMs,
    timeZone: props.timeZone,
    selecting,
    checked,
  });
  const onTap = (): void => {
    if (consumeClickSuppression()) return;
    if (selecting) {
      props.onToggle?.(channel.channelId);
      return;
    }
    // A thread selecting messages exits that first (history.back()).
    leaveSelectionThen(() => props.onSelect(channel));
  };
  // The tap surface's behaviour (the part draws it): long-press, press-in,
  // right-click, Shift+F10, its name and its pressed state while selecting.
  const surface = {
    buttonRef: rowRef,
    ...(menuEnabled
      ? {
          onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
            holdFiredRef.current = false;
            handlers.onPointerDown(e);
            pressDown(e);
          },
          onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
            handlers.onPointerMove(e);
            press.move(e);
          },
          onPointerUp: () => {
            handlers.onPointerUp();
            press.cancel();
          },
          onPointerCancel: () => {
            handlers.onPointerCancel();
            press.cancel();
          },
        }
      : { ...pressHandlers, onPointerDown: pressDown }),
    onContextMenu: (e: MouseEvent) => {
      if (coarsePointer) e.preventDefault();
      if (!menuEnabled) return;
      e.preventDefault();
      cancel();
      // Touch-first: a contextmenu that beats the hold timer acts as the hold, once.
      if (coarsePointer && holdFiredRef.current) return;
      holdFiredRef.current = true;
      openMenu();
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!menuEnabled || !rowMenuKey(e)) return;
      e.preventDefault();
      openMenu();
    },
    'aria-label': channelTileLabel({
      title: parts.name,
      unread: summary?.unread ?? 0,
      preview: summary !== undefined && summary.lastMessageTs > 0 ? previewLine(summary) : '',
      time: parts.time,
      draft: props.draft ?? null,
    }),
    ...(selecting ? { 'aria-pressed': checked } : {}),
  };
  const isSelected = channelRowSelected({ selected: props.selected, selecting, checked });
  const menu = menuEnabled ? (
    <ActionMenu
      title={parts.name}
      items={chatRowMenuItems(() => props.onHide?.(channel))}
      open={props.menuOpen === true}
      onOpenChange={(open) => {
        if (open) openMenu();
        else props.onMenuClose?.();
      }}
      trigger={
        <ActionMenuTrigger
          type="button"
          data-more=""
          label={`Actions for ${parts.name}`}
          aria-expanded={props.menuOpen === true}
          className={ROW_MORE_INK}
        />
      }
    />
  ) : null;
  return (
    <div
      data-chat-list-item={parts.kind === 'wide' ? 'row' : 'tile'}
      className={cn('h-full', NO_TOUCH_SELECT)}
      // Touch-first: the native menu and callout never show on a chat.
      onContextMenu={chatRowContextMenu(coarsePointer)}
    >
      {parts.kind === 'wide' ? (
        <Row
          {...surface}
          leading={parts.photo}
          title={parts.name}
          {...(parts.time !== '' ? { time: parts.time } : {})}
          secondary={parts.preview}
          badge={parts.pill}
          {...(menu !== null
            ? { trailing: { kind: 'more' as const, menu } }
            : parts.check !== null
              ? { trailing: { kind: 'node' as const, node: parts.check } }
              : {})}
          divider={props.divider === true}
          selected={isSelected}
          onPress={onTap}
        />
      ) : (
        <Tile
          thumbnail={parts.photo}
          title={parts.name}
          {...(parts.time !== '' ? { meta: <span data-tile-time="">{parts.time}</span> } : {})}
          {...(menu !== null ? { more: menu } : {})}
          corners={{
            ...(parts.check !== null
              ? { tl: <span className={TILE_CORNER_INSET}>{parts.check}</span> }
              : {}),
            ...(parts.pill !== null
              ? { tr: <span className={TILE_CORNER_INSET}>{parts.pill}</span> }
              : {}),
          }}
          press={{ ...surface, selected: isSelected, onClick: onTap }}
        />
      )}
    </div>
  );
}

/**
 * The Personal notes row: a ui/Row above Groups, the notebook (or own photo)
 * at the header role, "Personal notes" over "Only you can see this". Paints
 * the same in every list state (loading, error, ready) from the session alone,
 * so the first paint is final. No motion. Not selectable in Select mode
 * (inert). Hook-free so it is unit tested.
 */
export function notesTile(props: {
  notes: ChannelSummary;
  /** The notes chat's last note, when one is loaded: its preview and time replace the tagline. */
  summary?: ConversationSummary | undefined;
  nowMs?: number | undefined;
  timeZone?: string | undefined;
  selected: boolean;
  /** Select mode is on: the tile is inert. */
  selecting: boolean;
  onSelect: (channel: ChannelSummary) => void;
}): ReactElement {
  const { notes, summary } = props;
  const last = notesLastLine(summary, props.nowMs ?? 0, props.timeZone);
  return (
    <div className={cn('pb-2', NO_TOUCH_SELECT)}>
      <Row
        data-notes-tile=""
        aria-label={`Open ${chatDisplayName(notes)}`}
        leading={<NotesAvatar role="header" src={notes.avatarUrl} surface="panel" />}
        title={chatDisplayName(notes)}
        {...(last !== null && last.time !== ''
          ? { time: <span data-notes-time="">{last.time}</span> }
          : {})}
        secondary={
          <span data-notes-preview="">{last !== null ? last.preview : NOTES_TILE_LINE}</span>
        }
        disabled={props.selecting}
        selected={props.selected && !props.selecting}
        onPress={() => {
          if (props.selecting) return;
          // A thread selecting messages exits that first (history.back()).
          leaveSelectionThen(() => props.onSelect(notes));
        }}
      />
    </div>
  );
}

/**
 * The notes tile's second line: the last note's preview and its time, or null
 * when no note is loaded yet (the tile keeps its tagline). Pure.
 */
export function notesLastLine(
  summary: ConversationSummary | undefined,
  nowMs: number,
  timeZone?: string,
): { preview: string; time: string } | null {
  if (summary === undefined || summary.lastMessageTs <= 0) return null;
  const preview = stripFormat(summary.lastMessageText);
  if (preview === '') return null;
  return { preview, time: formatChatTime(summary.lastMessageTs, new Date(nowMs), timeZone) };
}

/** A chat home chip: Starred, or one of the message search kinds. */
export type HomeChip = SearchKind | 'starred';

/** The chat home chips in order: Starred first, then the search kinds. */
export const HOME_CHIPS: readonly { kind: HomeChip; label: string }[] = [
  { kind: 'starred', label: STARRED_TITLE },
  ...SEARCH_CHIPS,
];

/** One chip at a time: tapping the active one clears it, another replaces it. Pure. */
export function toggleHomeChip(current: HomeChip | null, tapped: HomeChip): HomeChip | null {
  return current === tapped ? null : tapped;
}

/** The message search kind a chip runs (Starred runs none). Pure. */
export function searchKindOf(chip: HomeChip | null): SearchKind | null {
  return chip === null || chip === 'starred' ? null : chip;
}

/**
 * The chips under the search box: Starred, then Photos, Videos, Links, Files,
 * Voice notes (WhatsApp's order). One at a time (tap again to clear). Each is ui/Chip with its
 * selected style, as on the other list pages (no counts: these filter
 * messages, nothing is tallied); the row scrolls on X when it overflows (no
 * scrollbar), chips never wrap or shrink. Tokens only, no motion. Hook-free.
 */
export function searchChips(props: {
  kind: HomeChip | null;
  onChange: (kind: HomeChip | null) => void;
}): ReactElement {
  return (
    <div
      data-search-chips=""
      role="group"
      aria-label="Filter messages"
      className="flex min-w-0 flex-1 touch-pan-x flex-nowrap gap-2 overflow-x-auto overflow-y-hidden pr-10 [mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] [scrollbar-width:none] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] [&::-webkit-scrollbar]:hidden"
    >
      {HOME_CHIPS.map((chip) => {
        const on = props.kind === chip.kind;
        return (
          <Chip
            key={chip.kind}
            label={chip.label}
            selected={on}
            size="tap"
            data-search-chip={chip.kind}
            aria-pressed={on}
            onClick={() => props.onChange(toggleHomeChip(props.kind, chip.kind))}
            className={cn('shrink-0 whitespace-nowrap', NO_TOUCH_SELECT)}
          />
        );
      })}
    </div>
  );
}

interface ChannelListContentProps extends ChannelListProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels, threaded to the cards. */
  nowMs?: number;
  /** Hidden-chat lookup; absent in pure tests (nothing is hidden). */
  isHidden?: HiddenLookup;
  /** Select mode controls; absent hides the Select control. */
  select?: ChannelSelectMode;
  /** Row long-press; absent disables the row menu. */
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
  /** The chat whose row menu is open, its close, and its Hide chat. */
  menuOpenId?: string | null;
  onMenuClose?: () => void;
  onHide?: (channel: ChannelSummary) => void;
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** The list's input, read once by ChannelList; touch when absent. */
  input?: ChannelListInput;
  /**
   * The message search results; they replace the list (no old list under them)
   * while the box holds 2+ characters or a chip is on. Absent: the name filter only.
   */
  searchResults?: ReactNode;
  /** The active filter chip and its setter; absent shows no chips. */
  kind?: HomeChip | null;
  onKindChange?: (kind: HomeChip | null) => void;
}

/** Whether the search box (or a chip) holds enough to show the message results. Pure. */
export function showSearchResults(search: string, kind: HomeChip | null = null): boolean {
  return kind !== null || normalizeQuery(search).length >= SEARCH_MIN_CHARS;
}

/**
 * A chat's recency key for the list order: its last message time, or, for a
 * chat with no message yet, when it was created, so a just-created group or
 * DM sorts at the top of its section. Other chats keep their key (a reload
 * moves nothing whose key did not change). Pure.
 */
export function recencyKey(channel: ChannelSummary, summaryFor: SummaryLookup): number {
  const last = summaryFor(channel.channelId)?.lastMessageTs ?? 0;
  if (last > 0) return last;
  const created = Date.parse(channel.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/**
 * The rows the list shows, most recent first. A hidden chat (deleted for the
 * caller, nothing newer since) is left out of the plain list, but a name
 * search still finds it so it can be reopened.
 */
export function visibleChannels(
  channels: readonly ChannelSummary[],
  summaryFor: SummaryLookup,
  isHidden: HiddenLookup,
  search: string,
): ChannelSummary[] {
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const ordered = sortChannelsByRecency(channels, (id) => {
    const channel = byId.get(id);
    return { lastMessageTs: channel !== undefined ? recencyKey(channel, summaryFor) : 0 };
  });
  if (search.trim() === '') return ordered.filter((c) => !isHidden(c.channelId));
  return filterChannelsByName(ordered, search);
}

/**
 * The list's layout classes. Locked (default): a full-height column whose body
 * scrolls itself. Page scroll (phone): the column and body grow with the rows
 * and the document scrolls them; the header row (search or select header)
 * pins below the sticky Topbar on the page background it already sits on, and
 * the select bar pins above the floating tab bar (the same 84px + home
 * indicator room <main> keeps for it, AppLayout shellChrome). Only position
 * changes: colours, borders, spacing and lighting are the same in both. Pure.
 */
export function channelListClasses(pageScroll: boolean): {
  column: string;
  header: string;
  body: string;
  selectBar: string;
} {
  return pageScroll
    ? {
        column: 'flex flex-col',
        // A flex item, so the header row's top margin stays inside the
        // pinned box: no rows show through a gap above it while it is stuck.
        header: cn('sticky z-20 bg-bg', SHELL_STICKY_TOP_CLASS),
        body: 'flex-1',
        selectBar: 'sticky bottom-[calc(84px+env(safe-area-inset-bottom))] z-20',
      }
    : {
        column: 'flex h-full flex-col',
        header: '',
        body: 'min-h-0 flex-1 overflow-y-auto',
        selectBar: '',
      };
}

/** Header in select mode: the checked count and Cancel. */
function selectHeader(select: ChannelSelectMode, className = ''): ReactElement {
  return (
    <div
      className={cn('flex items-center gap-2 border-b border-border px-4 py-3 md:px-6', className)}
    >
      <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
        {`${select.selectedIds.size} selected`}
      </span>
      <Button variant="ghost" onClick={select.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Bottom bar in select mode (SelectionBar styling): one Hide, disabled at 0. */
function selectBar(select: ChannelSelectMode, className = ''): ReactElement {
  return (
    <div className={cn('flex items-center gap-2 border-t bg-panel px-4 py-3 lit-dock', className)}>
      <Button
        variant="primary"
        className="ml-auto"
        disabled={select.selectedIds.size === 0}
        onClick={select.onDelete}
      >
        <IconEyeOff size={ICON_SIZE.inline} />
        Hide
      </Button>
    </div>
  );
}

/**
 * The full channel list pane: the shared SectionHeader (controlled name search +
 * accent "+" New chat, no sort, no chips) above the body. While loading the body
 * is skeleton rows and on error a Retry state; Select, rows and the empty state
 * appear only once the store is ready, already hidden-filtered and sorted. Pure (no
 * hooks) so the search wiring and the single-header guarantee are unit tested by
 * walking the returned tree; ChannelList owns the search state.
 */
export function channelListContent(props: ChannelListContentProps): ReactElement {
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const isHidden: HiddenLookup = props.isHidden ?? (() => false);
  const ready = props.status === 'ready';
  const hasChannels = ready && props.channels.some((c) => !isHidden(c.channelId));
  const select = ready ? props.select : undefined;
  const selecting = select?.active === true ? select : undefined;
  // New chat from a thread selecting messages exits that first (history.back()).
  const newChat = (): void => leaveSelectionThen(props.onNewChat);
  const kind = props.kind ?? null;
  const searching = props.searchResults !== undefined && showSearchResults(props.search, kind);
  const onKindChange = props.onKindChange;
  const layout = channelListClasses(props.pageScroll === true);
  return (
    <div className={layout.column}>
      {selecting !== undefined ? (
        selectHeader(selecting, layout.header)
      ) : (
        // The app's own Clear (X) is the only one: the browser's native
        // search cancel button is hidden.
        <div
          className={cn(
            'border-b border-border pb-3 [&_input::-webkit-search-cancel-button]:hidden',
            layout.header,
          )}
        >
          <SectionHeader
            stackSearchMd
            search={{
              value: props.search,
              onChange: props.onSearchChange,
              placeholder: 'Search chats',
              label: 'Search chats',
            }}
            primaryAction={{
              node: (
                <>
                  {select !== undefined && hasChannels ? (
                    <IconButton label="Select" onClick={select.onStart}>
                      <IconCheckCircle size={ICON_SIZE.control} />
                    </IconButton>
                  ) : null}
                  <Button
                    variant="primary"
                    className="shrink-0 whitespace-nowrap"
                    onClick={newChat}
                  >
                    <IconPlus size={ICON_SIZE.inline} />
                    New chat
                  </Button>
                </>
              ),
            }}
          >
            {onKindChange !== undefined ? searchChips({ kind, onChange: onKindChange }) : undefined}
          </SectionHeader>
        </div>
      )}
      <div className={layout.body}>
        {props.lead !== undefined && !searching ? props.lead : null}
        {props.notes !== undefined && !searching
          ? notesTile({
              notes: props.notes,
              summary: summaryFor(props.notes.channelId),
              nowMs: props.nowMs ?? 0,
              timeZone: props.timeZone,
              selected: props.notes.channelId === props.selectedChannelId,
              selecting: selecting !== undefined,
              onSelect: props.onSelect,
            })
          : null}
        <SettleLanding boxes={props.status === 'loading'} selector="[data-chat-home] li">
          {props.status === 'loading'
            ? channelListSkeleton()
            : props.status === 'error'
              ? channelListError(props.onRetry)
              : searching
                ? props.searchResults
                : channelListView({
                    channels: visibleChannels(props.channels, summaryFor, isHidden, props.search),
                    hasChannels: hasChannels || props.search.trim() !== '',
                    search: props.search,
                    onClearSearch: () => props.onSearchChange(''),
                    selectedChannelId: props.selectedChannelId,
                    onSelect: props.onSelect,
                    ...(props.onPressIn !== undefined ? { onPressIn: props.onPressIn } : {}),
                    onNewChat: newChat,
                    summaryFor,
                    ...(props.draftFor !== undefined ? { draftFor: props.draftFor } : {}),
                    ...(selecting !== undefined
                      ? {
                          selecting: {
                            selectedIds: selecting.selectedIds,
                            onToggle: selecting.onToggle,
                          },
                        }
                      : {}),
                    ...(props.onLongPress !== undefined && selecting === undefined
                      ? {
                          onLongPress: props.onLongPress,
                          menuOpenId: props.menuOpenId ?? null,
                          ...(props.onMenuClose !== undefined
                            ? { onMenuClose: props.onMenuClose }
                            : {}),
                          ...(props.onHide !== undefined ? { onHide: props.onHide } : {}),
                        }
                      : {}),
                    ...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {}),
                    ...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {}),
                    ...(props.input !== undefined ? { input: props.input } : {}),
                  })}
        </SettleLanding>
      </div>
      {selecting !== undefined ? selectBar(selecting, layout.selectBar) : null}
    </div>
  );
}

/** Confirm title: "Hide this chat?" / "Hide N chats?". Pure. */
export function hideChatsTitle(count: number): string {
  return count === 1 ? 'Hide this chat?' : `Hide ${count} chats?`;
}

/** Confirm body: the hide is local to the caller and undone by a new message. */
export const DELETE_CHATS_MESSAGE =
  'Hidden for you only. It comes back if someone sends a new message.';

/**
 * The delete-for-me confirm, or null when nothing is pending. Hook-free so the
 * confirm and cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteChatsConfirm(props: {
  channels: readonly ChannelSummary[] | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (props.channels === null) return null;
  return (
    <ConfirmDialog
      title={hideChatsTitle(props.channels.length)}
      message={DELETE_CHATS_MESSAGE}
      confirmLabel="Hide"
      busyLabel="Hiding"
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

/** Scrollable channel list pane with the shared search/create header. */
export function ChannelList(props: ChannelListProps): ReactElement {
  const listWorkspaceId = props.workspaceId ?? null;
  const [search, setSearch] = useState('');
  // The filter chip: one at a time, tap again to clear.
  const [kind, setKind] = useState<HomeChip | null>(null);
  // The Starred list's Edit mode; any chip change leaves it.
  const [starEditing, setStarEditing] = useState(false);
  useEffect(() => setStarEditing(false), [kind]);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The chat whose row menu is open (ActionMenu: a sheet on phone, a popover at its ⋯ on laptop).
  const [menu, setMenu] = useState<ChannelSummary | null>(null);
  const [confirm, setConfirm] = useState<ChannelSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { state } = useChatStore();
  const summaryFor = useCallback<SummaryLookup>(
    (channelId) => selectConversation(state, channelId),
    [state],
  );
  const isHidden = useCallback<HiddenLookup>(
    (channelId) => selectHidden(state, channelId),
    [state],
  );
  // Drafts live outside React; re-read the rows whenever one changes.
  const drafts = useSyncExternalStore(subscribeDrafts, draftsVersion, draftsVersion);
  const draftFor = useCallback<DraftLookup>(
    (channelId) => draftLine(draftText(channelId), listWorkspaceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, listWorkspaceId],
  );
  const onDeleteChats = props.onDeleteChats;
  const closeMenu = useCallback(() => setMenu(null), []);
  const exitSelect = (): void => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  async function runDelete(list: ChannelSummary[]): Promise<void> {
    if (onDeleteChats === undefined || busy || list.length === 0) return;
    setBusy(true);
    const result = await onDeleteChats(list);
    setBusy(false);
    setConfirm(null);
    if (result.ok) {
      exitSelect();
      return;
    }
    toast.show({ title: deleteChatFailedMessage(chatDisplayName(result.failed)) });
    // The chats before the failed one are gone; keep the rest checked.
    const at = list.findIndex((c) => c.channelId === result.failed.channelId);
    setSelectedIds(new Set(list.slice(Math.max(0, at)).map((c) => c.channelId)));
  }

  // One layout listener (and hover / coarse query) for the whole list.
  const input = useChannelListInput();

  // Message search: 2+ characters run the server search (debounced, each
  // keystroke aborting the last); under 2 the name filter alone. Names come
  // from the loaded roster and the workspace's name registry, never per row.
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;
  const { state: searchState, runner: searchRunner } = useMessageSearch({
    workspaceId: listWorkspaceId,
  });
  // Starred lists stars, never message hits: the search stays idle under it.
  useEffect(() => {
    if (kind === 'starred') searchRunner?.setQuery('', null);
    else searchRunner?.setQuery(search, searchKindOf(kind));
  }, [searchRunner, search, kind]);
  // Media chips (WhatsApp): the items themselves. The chip's first page is
  // kept on the device (`chat:media:{kind}`), so a tap paints from it before
  // any read; the network page swaps in under the same keys (no blink).
  const mediaKind = searchKindOf(kind);
  const mediaKey =
    mediaKind !== null && currentUserId !== null && listWorkspaceId !== null
      ? readKey(currentUserId, listWorkspaceId, mediaCacheWhat(mediaKind))
      : null;
  const mediaRaw = mediaKey !== null ? peekKept<unknown>(mediaKey) : undefined;
  const mediaCached: MediaCacheValue | undefined =
    mediaKind !== null && isMediaCacheValue(mediaRaw, mediaKind) ? mediaRaw : undefined;
  const savedMedia = useRef('');
  useEffect(() => {
    if (mediaKey === null || mediaKind === null) return;
    const s = searchState;
    if (s.status !== 'ready' || s.kind !== mediaKind || s.query !== '') return;
    const first = s.hits.slice(0, SEARCH_PAGE_SIZE);
    const signature = `${mediaKey}|${first.map((h) => h.id).join(',')}`;
    if (savedMedia.current === signature) return;
    savedMedia.current = signature;
    const items = flattenHits(first, mediaKind, {
      appOrigin: currentOrigin(),
      routes: APP_ENTITY_ROUTES,
      isRemoved: (channelId, messageId, versionId) =>
        isFileRemoved(removedFilesStore.get(channelId), messageId, versionId),
    });
    primeRead<MediaCacheValue>(mediaKey, { kind: mediaKind, items });
  }, [mediaKey, mediaKind, searchState]);
  const onKindChange = useCallback((next: HomeChip | null) => {
    if (next !== null && next !== 'starred') mark('chat:chip:tap');
    setKind(next);
  }, []);
  // Hits in notes carry its name ("Personal notes") and notebook.
  const notes = props.notes;
  const channelsById = useMemo(() => {
    const byId = new Map(props.channels.map((c) => [c.channelId, c] as const));
    if (notes !== undefined) byId.set(notes.channelId, notes);
    return byId;
  }, [props.channels, notes]);
  const nameOf = useMemo(() => mentionNamesIn(listWorkspaceId), [listWorkspaceId]);
  const onOpenSearchHit = props.onOpenSearchHit;
  const openHit = useCallback(
    (channel: ChannelSummary, hit: SearchHit, query: string) =>
      leaveSelectionThen(() =>
        onOpenSearchHit !== undefined
          ? onOpenSearchHit(channel, hit.id, query)
          : props.onSelect(channel),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onOpenSearchHit, props.onSelect],
  );
  const openChat = useCallback(
    (channel: ChannelSummary) => leaveSelectionThen(() => props.onSelect(channel)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onSelect],
  );
  const onOpenStarred = props.onOpenStarred;
  const nowMs = Date.now();
  const searchResults =
    kind === 'starred' ? (
      <div data-starred-home="" className="px-4 pb-4 pt-1">
        <StarredList
          channelId={null}
          query={search}
          onClearQuery={() => setSearch('')}
          showChat
          channelsById={channelsById}
          currentUserId={currentUserId ?? ''}
          {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
          nowMs={nowMs}
          inlineEdit
          editing={starEditing}
          onEditingChange={setStarEditing}
          onOpen={(row) => {
            const channel = channelsById.get(row.channelId);
            if (channel === undefined) return;
            leaveSelectionThen(() =>
              onOpenStarred !== undefined
                ? onOpenStarred(channel, row.id)
                : props.onSelect(channel),
            );
          }}
        />
      </div>
    ) : mediaKind !== null ? (
      <MediaResults
        kind={mediaKind}
        query={search}
        state={searchState}
        runner={searchRunner}
        cached={mediaCached}
        channelsById={channelsById}
        currentUserId={currentUserId}
        nameOf={nameOf}
        nowMs={nowMs}
        {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
        onClear={() => {
          setSearch('');
          setKind(null);
        }}
        onShowInChat={(channelId, messageId) => {
          const channel = channelsById.get(channelId);
          if (channel === undefined) return;
          leaveSelectionThen(() =>
            onOpenStarred !== undefined
              ? onOpenStarred(channel, messageId)
              : props.onSelect(channel),
          );
        }}
      />
    ) : showSearchResults(search, kind) ? (
      <SearchResults
        query={search}
        kind={searchKindOf(kind)}
        chats={visibleChannels(props.channels, summaryFor, isHidden, search)}
        state={searchState}
        runner={searchRunner}
        channelsById={channelsById}
        currentUserId={currentUserId}
        nameOf={nameOf}
        nowMs={nowMs}
        {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
        onOpenChat={openChat}
        onOpenHit={openHit}
        onClear={() => {
          setSearch('');
          setKind(null);
        }}
      />
    ) : undefined;
  return (
    <>
      {channelListContent({
        ...props,
        input,
        search,
        onSearchChange: setSearch,
        kind,
        onKindChange,
        ...(searchResults !== undefined ? { searchResults } : {}),
        summaryFor,
        isHidden,
        draftFor,
        nowMs,
        ...(onDeleteChats !== undefined
          ? {
              select: {
                active: selecting,
                selectedIds,
                onStart: () => {
                  setMenu(null);
                  setSelectedIds(new Set());
                  setSelecting(true);
                },
                onCancel: exitSelect,
                onToggle: (channelId: string) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(channelId)) next.delete(channelId);
                    else next.add(channelId);
                    return next;
                  }),
                onDelete: () =>
                  setConfirm(props.channels.filter((c) => selectedIds.has(c.channelId))),
              },
              onLongPress: (channel: ChannelSummary) => setMenu(channel),
              menuOpenId: menu?.channelId ?? null,
              onMenuClose: closeMenu,
              onHide: (channel: ChannelSummary) => setConfirm([channel]),
            }
          : {}),
      })}
      {onDeleteChats !== undefined
        ? deleteChatsConfirm({
            channels: confirm,
            busy,
            onCancel: () => setConfirm(null),
            onConfirm: () => void runDelete(confirm ?? []),
          })
        : null}
    </>
  );
}
