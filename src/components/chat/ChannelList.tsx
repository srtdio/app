import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { stripFormat } from '@srtdio/comments';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { createPressIntent, type PressIntent } from '@/lib/chat/press-intent';
import { IconButton } from '@/components/ui/IconButton';
import { countBadgeText } from '@/components/ui/CountBadge';
import {
  LIST_CARD_STACK,
  ListCard,
  ListCardBox,
  type ListCardPicture,
} from '@/components/ui/ListCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { useLongPress } from '@/components/ui';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { Chip } from '@/components/ui/Chip';
import {
  ICON_SIZE,
  IconChat,
  IconCheckCircle,
  IconEyeOff,
  IconFile,
  IconForward,
  IconPlus,
  IconTrash,
} from '@/components/ui/icons';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { cn } from '@/lib/cn';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';
import { BoxSkeleton, GlideItem } from '@/lib/motion';
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
import { formatAgo } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { draftText, draftsVersion, subscribeDrafts } from '@/lib/chat/drafts';
import { mentionNamesIn, resolveMentionPreview, splitAllMentions } from '@/lib/chat/mentions';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { summaryIconOfLine } from '@/lib/chat/thread';
import { SummaryGlyph } from '@/components/chat/ReplyQuote';
import { SearchResults, useMessageSearch } from '@/components/chat/SearchResults';
import { MediaResults } from '@/components/chat/MediaResults';
import { ForwardPicker, type ForwardSendResult } from '@/components/chat/ForwardPicker';
import { DELETE_FOR_ME_LABEL } from '@/components/chat/DeleteSheet';
import {
  EMPTY_MEDIA_SELECTION,
  mediaSelectionItems,
  toggleMediaSelection,
  type MediaSelection,
} from '@/lib/chat/media-select';
import { useDeleteForMe, type HideItem } from '@/lib/chat/use-delete-for-me';
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
import { useSession } from '@/lib/session-context';
import { summaryWithoutHidden, useHiddenIds } from '@/lib/chat/hides';
import { openCache } from '@/lib/chat/open-cache';
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
      <span key={`part-${i}`} data-mention-all="" className="font-semibold">
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
  /** Hides the checked chats (behind the Undo toast); a chip view: Delete for me. */
  onDelete: () => void;
  /**
   * A chip view selects items (messages), not chats: the bar is Forward (when
   * `onForward` is set) and Delete for me, never Hide. Absent: chats.
   */
  media?: { onForward?: (() => void) | undefined };
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
  /** A media item's Show in chat: open that chat at that message (no search bar). */
  onOpenAtMessage?: (channel: ChannelSummary, messageId: string) => void;
  /**
   * The caller's Personal notes (built from the session, never read): its
   * card paints from the first frame and, once the list is in, sorts in with
   * the chats by its last note; search hits in it carry its name. Absent: no
   * card.
   */
  notes?: ChannelSummary;
  /** Rendered at the top of the home list (hidden while searching), e.g. the getting-started card. */
  lead?: ReactNode;
  /** A chip view's Forward: the chats the picker lists (hidden ones included). */
  forwardChannels?: readonly ChannelSummary[];
  /** A chip view's Forward: send these messages (by id) to the chosen chats. Absent: no Forward. */
  onForwardMessages?: (
    items: readonly HideItem[],
    targets: ChannelSummary[],
  ) => Promise<ForwardSendResult>;
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
  const notes = props.notes;
  const renderCard = (channel: ChannelSummary): ReactElement => {
    if (notes !== undefined && channel.channelId === notes.channelId) {
      // Personal notes sorts in with the chats by its last note.
      return (
        <GlideItem as="li" axis="y" key={channel.channelId} className="min-w-0">
          {notesCard({
            notes,
            summary: summaryFor(notes.channelId),
            nowMs,
            timeZone,
            selected: notes.channelId === props.selectedChannelId,
            selecting: props.selecting !== undefined,
            onSelect: props.onSelect,
          })}
        </GlideItem>
      );
    }
    // Glide: a reorder (new message lifts a chat) moves rows to their new
    // place on Y.
    return (
      <GlideItem
        as="li"
        axis="y"
        key={channel.channelId}
        className="min-w-0"
        {...(channel.channelType === 'group' ? groupAnchor(channel) : {})}
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
  };
  return (
    <div data-chat-home="" className={CHAT_HOME_STACK}>
      <ul data-chat-list="" className={CHAT_ROW_LIST}>
        {props.channels.map((channel) => renderCard(channel))}
      </ul>
    </div>
  );
}

/** Skeleton tiles shown while the list loads; enough to fill a phone screen. */
export const SKELETON_ROWS = 6;

/** One loading card: ui/ListCardBox, the ListCard's own frame and slots. */
function skeletonRow(i: number): ReactElement {
  return (
    <li key={`bone-${i}`} data-skeleton-row="card" className="min-w-0">
      <ListCardBox round />
    </li>
  );
}

/**
 * The loading body: the real list's shape, drawn in the same frame (six
 * uniform cards, the ListCard's one height with its 72 picture, no labels),
 * so swapping in the list shifts nothing. Each box is a motion
 * Bone (top-lit sweep, never a pulse); no spinner. Shown only when the device
 * holds no list (the store paints a saved list at once).
 */
export function channelListSkeleton(): ReactElement {
  return (
    <BoxSkeleton lit="flat" className={CHAT_HOME_STACK} label="Loading conversations">
      <ul className={CHAT_ROW_LIST}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => skeletonRow(i))}
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
 * "Open Priya, 3 unread, Draft: see you, 5m". Pure.
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

/** A chat's picture shape: a group is 'wide' (its photo or mark), a DM 'square' (a person). */
export type TileKind = 'wide' | 'square';

/** A channel's picture shape: group -> wide, DM -> square. Pure. */
export function tileKind(channel: Pick<ChannelSummary, 'channelType'>): TileKind {
  return channel.channelType === 'group' ? 'wide' : 'square';
}

/** The unread pill's text, or null when there is nothing unread (no pill). Pure. */
export function unreadPillText(unread: number): string | null {
  return unread > 0 ? countBadgeText(unread) : null;
}

/**
 * The home stack inside the one scroll container, 8px between blocks. The card
 * list sits on the 16 edge (CHAT_HOME_EDGE), like the search box above.
 */
export const CHAT_HOME_STACK = 'flex flex-col gap-2';

/** The home's 16 edge for the parts that do not draw their own. */
export const CHAT_HOME_EDGE = 'px-4';

/**
 * The one list: one ui/ListCard per chat, 12 between cards, on the home's 16
 * edge. Personal notes, groups and people are one card style.
 */
export const CHAT_ROW_LIST = cn(LIST_CARD_STACK, CHAT_HOME_EDGE);

/**
 * A chat card's photo slot (ListCard's 72 picture): a person's photo circle
 * (initials on their colour when none) or a group's photo or mark in the radius
 * 8 box, so the box is final on first paint.
 */
export const CHAT_ROW_PHOTO = 'flex shrink-0';

/**
 * A person card's preview when the DM has no message yet: a no-break space,
 * so the line is never collapsed (ListCard reserves its two lines anyway).
 */
export const EMPTY_PREVIEW = '\u00a0';

/** Row state that picks the row's selected look. */
export interface ChannelRowState {
  /** Desktop: this chat is open in the thread pane. */
  selected: boolean;
  /** Select mode is on. */
  selecting: boolean;
  /** Select mode: this tile is checked. */
  checked: boolean;
}

/**
 * Whether the card takes the one selected look (lit-selected): a checked chat
 * in select mode, or the chat open on desktop. Pure.
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

/** The unread tag on line 3: "3 new" ("99+ new"), or null when nothing is unread. Pure. */
export function unreadTagText(unread: number): string | null {
  const count = unreadPillText(unread);
  return count === null ? null : `${count} new`;
}

/** What a chat shows: the card's slot contents, built once. Hook-free and pure. */
export interface ChannelRowParts {
  /** Group or person; both are a ListCard. */
  kind: TileKind;
  /** The chat's display name (chatDisplayName). */
  name: string;
  /** The last message time ('' when there is none): line 3. */
  time: string;
  /** The 72 picture: a person circle, or the group's photo or mark. */
  picture: ListCardPicture;
  /** The picture slot's hook (data-group-photo / data-person-photo). */
  pictureHooks: { 'data-group-photo': string } | { 'data-person-photo': string };
  /** Line 2: the preview or "Draft: ..." (a DM with no message: a reserved empty line). */
  preview: ReactElement;
  /** Something unread: the dot on line 1. */
  unread: boolean;
  /** Line 3's tag: "3 new", or null. */
  tag: string | null;
  /** The select-mode check (where the ⋮ sits), or null. */
  check: ReactElement | null;
}

/**
 * The slot contents of one chat. Group and person are the same ListCard: the
 * 72 picture (a person circle, a group's photo or mark), the name and the
 * unread dot, the 2-line preview (or "Draft: ..."), then the time and the
 * "3 new" tag. The avatar URL is on the summary before the card mounts (one
 * batched list read), so a photo paints first, never the initials.
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
  // Line 3: how long ago the last message landed ("just now", "5m", "Yesterday").
  const time = hasMessage
    ? formatAgo(summary.lastMessageTs, new Date(props.nowMs), props.timeZone)
    : '';
  const preview =
    draft !== null ? (
      <span data-draft-preview="">
        <span className={cn('text-accent', DRAFT_PREFIX_TYPE)}>{DRAFT_PREFIX}</span>
        {boldAllMentions(draft)}
      </span>
    ) : !wide && !hasMessage ? (
      <span data-preview-empty="" aria-hidden="true">
        {EMPTY_PREVIEW}
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
  // The photo is part of the tap surface: a tap on it opens the chat (or
  // toggles it while selecting). The enlarged photo lives only inside a DM.
  const picture: ListCardPicture = wide
    ? {
        kind: 'image',
        node: (
          <Avatar
            name={name}
            {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
            role="profile"
            kind="group"
            decorative
          />
        ),
      }
    : { kind: 'person', name, src: channel.avatarUrl };
  return {
    kind,
    name,
    time,
    picture,
    pictureHooks: wide ? { 'data-group-photo': '' } : { 'data-person-photo': '' },
    preview,
    unread: unread > 0,
    tag: unreadTagText(unread),
    check: props.selecting ? <SelectCheck checked={props.checked} /> : null,
  };
}

/**
 * The ⋯ opener for a chat (H5): always visible, the trigger of the same
 * ActionMenu a long-press opens. ActionMenuTrigger owns the trailing rule, so
 * its glyph's visible edge sits on the card's content edge.
 * fg-3 at rest, full ink on hover, as before. Tokens only.
 */
export const ROW_MORE_INK = 'text-fg-3 hover:text-fg';

/** A chat row's menu rows: Hide chat (non-destructive: eye-off, never red; FT43). */
export function chatRowMenuItems(onHide: () => void): ActionMenuItem[] {
  return [{ id: 'hide', label: 'Hide chat', icon: IconEyeOff, onSelect: onHide }];
}

/**
 * One conversation, group or person: a ui/ListCard whose whole surface is one
 * button ("Open <name>"). A touch long-press (moving or scrolling cancels it),
 * right-click, Shift+F10, or the always-visible ⋯ (line 3's trailing slot)
 * opens the chat menu; the trailing click is swallowed so a long-press never
 * also opens the chat. In select mode a check sits where the ⋯ sits and a tap
 * toggles.
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
  /** Kept for callers: cards are 12 apart, no divider. */
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
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => {
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
      data-chat-list-item="card"
      data-chat-kind={parts.kind === 'wide' ? 'group' : 'person'}
      className={NO_TOUCH_SELECT}
      // Touch-first: the native menu and callout never show on a chat.
      onContextMenu={chatRowContextMenu(coarsePointer)}
    >
      <ListCard
        picture={parts.picture}
        pictureHooks={parts.pictureHooks}
        title={parts.name}
        unread={parts.unread}
        preview={parts.preview}
        time={parts.time}
        {...(parts.tag !== null ? { tag: parts.tag, tagHooks: { 'data-unread-tag': '' } } : {})}
        {...(menu !== null ? { menu } : {})}
        {...(parts.check !== null ? { check: parts.check } : {})}
        selected={isSelected}
        onPress={onTap}
        press={surface}
        pressRef={rowRef}
      />
    </div>
  );
}

/** What the Personal notes card takes. */
interface NotesCardProps {
  notes: ChannelSummary;
  /** The notes chat's last note, when one is loaded: its preview and time replace the tagline. */
  summary?: ConversationSummary | undefined;
  nowMs?: number | undefined;
  timeZone?: string | undefined;
  selected: boolean;
  /** Select mode is on: the tile is inert. */
  selecting: boolean;
  onSelect: (channel: ChannelSummary) => void;
}

/**
 * The Personal notes card: a ui/ListCard, the notebook icon as its picture,
 * "Personal notes" over the last note (or "Only you can see this"), how long
 * ago the last note landed on line 3. In the list it sorts in with the chats
 * by its last note. No motion. Not selectable in Select mode (inert).
 * Hook-free so it is unit tested.
 */
export function notesCard(props: NotesCardProps): ReactElement {
  const { notes, summary } = props;
  const last = notesLastLine(summary, props.nowMs ?? 0, props.timeZone);
  const name = chatDisplayName(notes);
  return (
    <ListCard
      data-notes-tile=""
      picture={{ kind: 'icon', icon: IconFile }}
      pictureHooks={{ 'data-notes-picture': '' }}
      title={name}
      preview={<span data-notes-preview="">{last !== null ? last.preview : NOTES_TILE_LINE}</span>}
      {...(last !== null && last.time !== ''
        ? { time: last.time, timeHooks: { 'data-notes-time': '' } }
        : {})}
      disabled={props.selecting}
      selected={props.selected && !props.selecting}
      press={{ 'aria-label': `Open ${name}` }}
      onPress={() => {
        if (props.selecting) return;
        // A thread selecting messages exits that first (history.back()).
        leaveSelectionThen(() => props.onSelect(notes));
      }}
    />
  );
}

/**
 * The notes card on its own, above the list body while the list is loading,
 * failed or empty: it paints from the session alone, so the first paint is
 * final. Hook-free.
 */
export function notesTile(props: NotesCardProps): ReactElement {
  return <div className={cn('pb-2', CHAT_HOME_EDGE, NO_TOUCH_SELECT)}>{notesCard(props)}</div>;
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
  return { preview, time: formatAgo(summary.lastMessageTs, new Date(nowMs), timeZone) };
}

/** A chat home chip: one of the message search kinds. */
export type HomeChip = SearchKind;

/** The chat home chips in order: the search kinds. */
export const HOME_CHIPS: readonly { kind: HomeChip; label: string }[] = SEARCH_CHIPS;

/** One chip at a time: tapping the active one clears it, another replaces it. Pure. */
export function toggleHomeChip(current: HomeChip | null, tapped: HomeChip): HomeChip | null {
  return current === tapped ? null : tapped;
}

/**
 * The chips under the search box: Photos, Videos, Links, Files,
 * Voice notes (WhatsApp's order). One at a time: tap it again, or its X,
 * to clear and return to the list (no All chip). Each is ui/Chip with its
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
            onClear={on ? () => props.onChange(null) : undefined}
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
        header: cn('sticky z-sticky bg-bg', SHELL_STICKY_TOP_CLASS),
        body: 'flex-1',
        selectBar: 'sticky bottom-[calc(84px+env(safe-area-inset-bottom))] z-sticky',
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
  if (select.media !== undefined) return mediaSelectBar(select, select.media, className);
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
 * Bottom bar in a chip view's select mode (the same frame as the chats' bar):
 * Forward, then Delete for me (danger), both disabled at 0. Never Hide.
 */
function mediaSelectBar(
  select: ChannelSelectMode,
  media: NonNullable<ChannelSelectMode['media']>,
  className = '',
): ReactElement {
  const none = select.selectedIds.size === 0;
  return (
    <div
      data-testid="media-select-bar"
      className={cn('flex items-center gap-2 border-t bg-panel px-4 py-3 lit-dock', className)}
    >
      {media.onForward !== undefined ? (
        <Button variant="ghost" data-selection-forward="" disabled={none} onClick={media.onForward}>
          <IconForward size={ICON_SIZE.inline} />
          Forward
        </Button>
      ) : null}
      <Button
        variant="danger"
        data-selection-delete=""
        className="ml-auto"
        disabled={none}
        onClick={select.onDelete}
      >
        <IconTrash size={ICON_SIZE.inline} />
        {DELETE_FOR_ME_LABEL}
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
  // Personal notes sorts in with the chats once the list is in; while it is
  // loading, failed or empty, its card sits above the body (from the session).
  const notesInList = props.notes !== undefined && hasChannels;
  const listed =
    notesInList && props.notes !== undefined ? [...props.channels, props.notes] : props.channels;
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
        {props.notes !== undefined && !searching && !notesInList
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
                    channels: visibleChannels(listed, summaryFor, isHidden, props.search),
                    ...(notesInList && props.notes !== undefined ? { notes: props.notes } : {}),
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

/** The Undo toast after a hide: "Chat hidden" / "3 chats hidden". Pure. */
export function hiddenChatsLabel(count: number): string {
  return count === 1 ? 'Chat hidden' : `${count} chats hidden`;
}

/** A hide that did not save: the chat it stopped at (the failure toast names it). */
class HideFailed extends Error {
  constructor(readonly channel: ChannelSummary) {
    super('hide failed');
  }
}

/** Scrollable channel list pane with the shared search/create header. */
export function ChannelList(props: ChannelListProps): ReactElement {
  const listWorkspaceId = props.workspaceId ?? null;
  const [search, setSearch] = useState('');
  // The filter chip: one at a time, tap again to clear.
  const [kind, setKind] = useState<HomeChip | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // A chip view selects items by message (message id to chat id).
  const [mediaSelection, setMediaSelection] = useState<MediaSelection>(EMPTY_MEDIA_SELECTION);
  // The chip view's forward picker: the messages to forward, or null (closed).
  const [forwardItems, setForwardItems] = useState<readonly HideItem[] | null>(null);
  // The chat whose row menu is open (ActionMenu: a sheet on phone, a popover at its ⋯ on laptop).
  const [menu, setMenu] = useState<ChannelSummary | null>(null);
  // Chats hidden behind the Undo toast: they leave the list at once and the
  // hide (chat_channel_clear) runs only when the toast ends; Undo puts them back.
  const [pendingHidden, setPendingHidden] = useState<ReadonlySet<string>>(new Set());
  const undoable = useUndoableAction();
  const { state } = useChatStore();
  // Delete for me: a card whose last message is hidden reads the latest
  // visible one the device holds (no read), else the empty line.
  const hiddenIds = useHiddenIds(listWorkspaceId);
  const summaryFor = useCallback<SummaryLookup>(
    (channelId) =>
      summaryWithoutHidden(
        selectConversation(state, channelId),
        hiddenIds,
        () => openCache.holding('thread').find((h) => h.key.channelId === channelId)?.value.rows,
      ),
    [state, hiddenIds],
  );
  const isHidden = useCallback<HiddenLookup>(
    (channelId) => pendingHidden.has(channelId) || selectHidden(state, channelId),
    [state, pendingHidden],
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
    setMediaSelection(EMPTY_MEDIA_SELECTION);
  };

  // Hide (the row menu, or the select-mode bar): no confirm. The chats leave
  // the list at once behind the Undo toast (UNDO_MS); the hide is written when
  // the toast ends. Undo, or a hide that fails, puts them back in place (the
  // list is sorted, so they land where they were).
  function hideChats(list: readonly ChannelSummary[]): void {
    if (onDeleteChats === undefined || list.length === 0) return;
    const ids = list.map((c) => c.channelId);
    const unpend = (): void =>
      setPendingHidden((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    setPendingHidden((prev) => new Set([...prev, ...ids]));
    exitSelect();
    undoable.run({
      label: hiddenChatsLabel(list.length),
      failure: (error) =>
        deleteChatFailedMessage(
          error instanceof HideFailed
            ? chatDisplayName(error.channel)
            : list.length === 1
              ? chatDisplayName(list[0] as ChannelSummary)
              : 'the chats',
          error instanceof HideFailed ? null : error,
        ),
      commit: async () => {
        const result = await onDeleteChats([...list]);
        // Hidden in the store now (or put back below): the pending set lets go.
        unpend();
        if (!result.ok) throw new HideFailed(result.failed);
      },
      revert: unpend,
    });
  }

  // One layout listener (and hover / coarse query) for the whole list.
  const input = useChannelListInput();

  // Message search: 2+ characters run the server search (debounced, each
  // keystroke aborting the last); under 2 the name filter alone. Names come
  // from the loaded roster and the workspace's name registry, never per row.
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;
  // A chip view's Delete for me: hidden at once, written when the Undo ends.
  const deleteForMe = useDeleteForMe({ userId: currentUserId, workspaceId: listWorkspaceId });
  const onForwardMessages = props.onForwardMessages;
  const forwardChannels = props.forwardChannels;
  const canForward = onForwardMessages !== undefined && forwardChannels !== undefined;
  const mediaSelecting = selecting && kind !== null;
  const { state: searchState, runner: searchRunner } = useMessageSearch({
    workspaceId: listWorkspaceId,
  });
  useEffect(() => {
    searchRunner?.setQuery(search, kind);
  }, [searchRunner, search, kind]);
  // Media chips (WhatsApp): the items themselves. The chip's first page is
  // kept on the device (`chat:media:{kind}`), so a tap paints from it before
  // any read; the network page swaps in under the same keys (no blink).
  const mediaKind = kind;
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
    if (next !== null) mark('chat:chip:tap');
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
  const onOpenAtMessage = props.onOpenAtMessage;
  // The list's one clock: every card's "5m" ages together, once a
  // minute, from one shared interval (no timer per card).
  const nowMs = useMinuteClock();
  const searchResults =
    mediaKind !== null ? (
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
          exitSelect();
          setSearch('');
          setKind(null);
        }}
        {...(mediaSelecting
          ? {
              selecting: {
                selection: mediaSelection,
                onToggle: (item: HideItem) =>
                  setMediaSelection((prev) => toggleMediaSelection(prev, item)),
              },
            }
          : {})}
        onShowInChat={(channelId, messageId) => {
          const channel = channelsById.get(channelId);
          if (channel === undefined) return;
          leaveSelectionThen(() =>
            onOpenAtMessage !== undefined
              ? onOpenAtMessage(channel, messageId)
              : props.onSelect(channel),
          );
        }}
      />
    ) : showSearchResults(search, kind) ? (
      <SearchResults
        query={search}
        kind={kind}
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
                selectedIds: mediaSelecting ? new Set(mediaSelection.keys()) : selectedIds,
                onStart: () => {
                  setMenu(null);
                  setSelectedIds(new Set());
                  setMediaSelection(EMPTY_MEDIA_SELECTION);
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
                onDelete: mediaSelecting
                  ? () => {
                      const items = mediaSelectionItems(mediaSelection);
                      exitSelect();
                      deleteForMe(items);
                    }
                  : () => hideChats(props.channels.filter((c) => selectedIds.has(c.channelId))),
                ...(mediaSelecting
                  ? {
                      media: {
                        onForward: canForward
                          ? () => setForwardItems(mediaSelectionItems(mediaSelection))
                          : undefined,
                      },
                    }
                  : {}),
              },
              onLongPress: (channel: ChannelSummary) => setMenu(channel),
              menuOpenId: menu?.channelId ?? null,
              onMenuClose: closeMenu,
              onHide: (channel: ChannelSummary) => hideChats([channel]),
            }
          : {}),
      })}
      {onForwardMessages !== undefined && forwardChannels !== undefined ? (
        <ForwardPicker
          historyStep
          open={forwardItems !== null && forwardItems.length > 0}
          onClose={() => setForwardItems(null)}
          channels={forwardChannels}
          onSend={(targets) => onForwardMessages(forwardItems ?? [], targets)}
          onSent={() => {
            setForwardItems(null);
            exitSelect();
          }}
        />
      ) : null}
    </>
  );
}
