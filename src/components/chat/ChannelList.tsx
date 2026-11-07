import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentType, PointerEvent, ReactElement, ReactNode } from 'react';
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
  type ListCardSelect,
} from '@/components/ui/ListCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader, SectionSelect } from '@/components/shell/SectionHeader';
import { TopbarPlus, useTopbarActions } from '@/components/shell/topbar-actions';
import { selectCountLabel } from '@/components/ui/SelectBar';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { textRole } from '@/components/ui/Text';
import { Chip } from '@/components/ui/Chip';
import {
  ICON_SIZE,
  IconChat,
  IconEyeOff,
  IconForward,
  IconTrash,
  type IconProps,
} from '@/components/ui/icons';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useSort } from '@/lib/use-sort';
import { cn } from '@/lib/cn';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';
import { BoxSkeleton, GlideItem } from '@/lib/motion';
import { SettleLanding } from '@/components/chat/SettleLanding';
import { useCoarsePointer, useHoverPointer } from '@/lib/use-is-laptop';
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
import {
  mentionNamesIn,
  personName,
  resolveMentionPreview,
  splitAllMentions,
} from '@/lib/chat/mentions';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { summaryIconOfLine } from '@/lib/chat/thread';
import { SummaryGlyph } from '@/components/chat/ReplyQuote';
import { useMessageSearch } from '@/components/chat/SearchResults';
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
import { SEARCH_CHIPS, SEARCH_PAGE_SIZE, type SearchKind } from '@/lib/chat/search';
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

/**
 * Select mode: a long-press (touch) or right-click / Shift-click / Cmd-click
 * (laptop) on a chat enters with that chat ticked (onEnter); a tap toggles;
 * unticking the last chat leaves. The bottom bar carries Cancel, "N selected"
 * and the actions (Hide chat; a chip view: Forward, Delete for me).
 */
export interface ChannelSelectMode {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  /** Enter select mode with this chat ticked (a chat card's long-press or right-click). */
  onEnter: (channelId: string) => void;
  /** The chip row's Select (SectionSelect): enter with nothing ticked. */
  onStart: () => void;
  onCancel: () => void;
  /** Tick or untick; unticking the last chat leaves select mode (the list's own wiring). */
  onToggle: (channelId: string) => void;
  /** Hide chat for the checked chats (behind the Undo toast); a chip view: Delete for me. */
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
  /** Opens the New chat sheet (the top bar's "+"). */
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
  /** A media item's Show in chat: open that chat at that message (no search bar). */
  onOpenAtMessage?: (channel: ChannelSummary, messageId: string) => void;
  /**
   * The caller's Personal notes (built from the session, never read): its
   * card paints from the first frame and, once the list is in, sorts in with
   * the chats by its last note; chip items in it carry its name. Absent: no
   * card.
   */
  notes?: ChannelSummary;
  /** Rendered at the top of the home list (hidden while a chip view shows), e.g. the getting-started card. */
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
  /** Whether any conversation is listed (not hidden). */
  hasChannels: boolean;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels; defaults to 0 when no summary is supplied. */
  nowMs?: number;
  /**
   * Select mode for the chat cards (absent: long-press and right-click do
   * nothing). While `active` a tap toggles; outside it a long-press or
   * right-click enters with that chat ticked. Personal notes is never selectable.
   */
  select?: ChatRowSelect;
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** The list's input, read once per list (never per row); touch when absent. */
  input?: ChannelListInput;
  /** The caller's own name: the Personal notes picture's initials when there is no photo. */
  ownName?: string | undefined;
}

/** What the chat cards need of select mode. */
export interface ChatRowSelect {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  onEnter: (channelId: string) => void;
  onToggle: (channelId: string) => void;
}

/** One chat card's ListCard `select`: ticked when its id is selected. Pure. */
export function chatRowSelectFor(select: ChatRowSelect, channelId: string): ListCardSelect {
  return {
    active: select.active,
    chosen: select.selectedIds.has(channelId),
    onEnter: () => select.onEnter(channelId),
    onToggle: () => select.onToggle(channelId),
  };
}

/**
 * What the rows need to know about the input, read by ChannelList once (one
 * listener per list, not one per row) and handed to every row.
 */
export interface ChannelListInput {
  /** The size table (touch or laptop). */
  layout: ChatLayout;
  /** A fine hover pointer (read once for the list; the cards draw no hover control). */
  hoverMenu: boolean;
  /** A touch-first pointer: the hold alone enters select mode, contextmenu is suppressed. */
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
 * The channel list body. Pure and exported so its two states are unit tested:
 * the zero-state when no conversations exist (the top bar's New chat is the
 * only create button), and one row per channel otherwise.
 */
export function channelListView(props: ChannelListBodyProps): ReactElement {
  if (!props.hasChannels || props.channels.length === 0) {
    return (
      <EmptyState
        icon={<IconChat size={ICON_SIZE.status} />}
        title="Chats with your team show up here."
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
            selecting: props.select?.active === true,
            onSelect: props.onSelect,
            ownName: props.ownName,
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
          {...(props.select !== undefined
            ? { select: chatRowSelectFor(props.select, channel.channelId) }
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
 * uniform rows, the ListCard's one 60 height with its round 40 picture, no labels),
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
 * list sits on the 16 edge (CHAT_HOME_EDGE), like the chip row above.
 */
export const CHAT_HOME_STACK = 'flex flex-col gap-2';

/** The home's 16 edge for the parts that do not draw their own. */
export const CHAT_HOME_EDGE = 'px-4';

/**
 * The one list: one ui/ListCard per chat, rows touching (LIST_CARD_STACK),
 * on the home's 16 edge. Personal notes, groups and people are one card style.
 */
export const CHAT_ROW_LIST = cn(LIST_CARD_STACK, CHAT_HOME_EDGE);

/**
 * A person card's preview when the DM has no message yet: a no-break space,
 * so line 2 keeps its 20 line with nothing to read.
 */
export const EMPTY_PREVIEW = '\u00a0';

/**
 * The card's contextmenu, caught before the card on a touch-first pointer: the
 * native menu and callout never show and the hold alone enters select mode (a
 * contextmenu that trails the hold must not toggle the chat straight back
 * off). A laptop's right-click is left to the card (it enters select mode).
 * Pure.
 */
export function chatRowContextMenu(
  coarsePointer: boolean,
): ((event: { preventDefault: () => void; stopPropagation: () => void }) => void) | undefined {
  return coarsePointer
    ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      }
    : undefined;
}

/** The unread tag on line 2: "3 new" ("99+ new"), or null when nothing is unread. Pure. */
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
  /** How long ago the last message landed (formatAgo; '' when there is none): line 1, right. */
  time: string;
  /** The 40 picture: a person circle, or the group's photo or mark. */
  picture: ListCardPicture;
  /** The picture slot's hook (data-group-photo / data-person-photo). */
  pictureHooks: { 'data-group-photo': string } | { 'data-person-photo': string };
  /** Line 2: the preview or "Draft: ..." (a DM with no message: an empty line). */
  preview: ReactElement;
  /** Something unread: the dot at the end of line 2. */
  unread: boolean;
  /** Line 2's tag: "3 new" only when unread, else null. */
  tag: string | null;
}

/**
 * The slot contents of one chat. Group and person are the same ListCard: the
 * 40 picture (a person circle, a group's photo or mark), line 1 the name and
 * how long ago, line 2 the one-line preview (or "Draft: ...") then the "3 new"
 * tag and the unread dot. The avatar URL is on the summary before the card
 * mounts (one batched list read), so a photo paints first, never the initials.
 */
export function channelRowParts(props: {
  channel: ChannelSummary;
  summary: ConversationSummary | undefined;
  /** The chat's unsent draft (not open): the preview reads "Draft: <text>". */
  draft?: string | null;
  nowMs: number;
  timeZone?: string | undefined;
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
  // Line 1, right: how long ago the last message landed ("just now", "5m", "Yesterday").
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
            role="card"
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
  };
}

/**
 * One conversation, group or person: a ui/ListCard whose whole surface is one
 * button ("Open <name>"). No ⋮: with `select`, a touch long-press (moving or
 * scrolling cancels it) or a right-click / Shift-click / Cmd-click enters the
 * list's select mode with this chat ticked (ListCard wires the gesture and
 * swallows the click that trails a hold); while selecting a tap toggles and
 * ListCard draws the tick on the picture.
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
  /** The list's input (coarse pointer), read once by the list. */
  input: ChannelListInput;
  /** Kept for callers: rows touch, no divider. */
  divider?: boolean;
  /** The list's select mode for this card; absent: long-press and right-click do nothing. */
  select?: ListCardSelect | undefined;
}): ReactElement {
  const { channel, summary } = props;
  const select = props.select;
  const selecting = select?.active === true;
  const { coarsePointer } = props.input;
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
  const parts = channelRowParts({
    channel,
    summary,
    draft: props.draft ?? null,
    nowMs: props.nowMs,
    timeZone: props.timeZone,
  });
  // A tap opens the chat; while selecting ListCard takes the tap (it toggles).
  // A thread selecting messages exits that first (history.back()).
  const onTap = (): void => leaveSelectionThen(() => props.onSelect(channel));
  // The tap surface's own behaviour (the part draws it): press-in and its name.
  const surface = {
    onPointerDown: pressDown,
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => press.move(e),
    onPointerUp: () => press.cancel(),
    onPointerCancel: () => press.cancel(),
    'aria-label': channelTileLabel({
      title: parts.name,
      unread: summary?.unread ?? 0,
      preview: summary !== undefined && summary.lastMessageTs > 0 ? previewLine(summary) : '',
      time: parts.time,
      draft: props.draft ?? null,
    }),
  };
  return (
    <div
      data-chat-list-item="card"
      data-chat-kind={parts.kind === 'wide' ? 'group' : 'person'}
      className={NO_TOUCH_SELECT}
      // Touch-first: the native menu and callout never show on a chat, and the
      // hold alone enters select mode (caught before the card's own handler).
      onContextMenuCapture={chatRowContextMenu(coarsePointer)}
    >
      <ListCard
        picture={parts.picture}
        pictureHooks={parts.pictureHooks}
        title={parts.name}
        unread={parts.unread}
        preview={parts.preview}
        time={parts.time}
        {...(parts.tag !== null ? { tag: parts.tag, tagHooks: { 'data-unread-tag': '' } } : {})}
        {...(select !== undefined ? { select } : {})}
        // The open chat (desktop) is lit; while selecting only the ticked ones are.
        selected={props.selected && !selecting}
        onPress={onTap}
        press={surface}
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
  /** The caller's own name: the picture's initials when there is no photo. */
  ownName?: string | undefined;
}

/**
 * The Personal notes card: a ui/ListCard whose person picture is the caller's
 * own photo (Avatar 'card', 40; the notes channel's avatarUrl, already in
 * memory), else their initials (ownName), else the person glyph. "Personal
 * notes" and how long ago the last note landed on line 1, the last note (or
 * "Only you can see this") on line 2. In the list it sorts in with the chats
 * by its last note. No motion. Never selectable: no `select`, and inert while
 * the list is selecting. Hook-free so it is unit tested.
 */
export function notesCard(props: NotesCardProps): ReactElement {
  const { notes, summary } = props;
  const last = notesLastLine(summary, props.nowMs ?? 0, props.timeZone);
  const name = chatDisplayName(notes);
  return (
    <ListCard
      data-notes-tile=""
      picture={{ kind: 'person', name: props.ownName ?? '', src: notes.avatarUrl }}
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
 * The chips in the chip row: Photos, Videos, Links, Files,
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
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels, threaded to the cards. */
  nowMs?: number;
  /** Hidden-chat lookup; absent in pure tests (nothing is hidden). */
  isHidden?: HiddenLookup;
  /** Select mode controls; absent: long-press does nothing, no Select and no select bar. */
  select?: ChannelSelectMode;
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** The list's input, read once by ChannelList; touch when absent. */
  input?: ChannelListInput;
  /** The caller's own name: the Personal notes picture's initials when there is no photo. */
  ownName?: string | undefined;
  /** The list order (the top bar's sort); Recent when absent. */
  sort?: ChatSort;
  /**
   * The chip view (MediaResults); it replaces the list (no old list under it)
   * while a chip is on. Absent: the list.
   */
  chipResults?: ReactNode;
  /** The active filter chip and its setter; absent shows no chips. */
  kind?: HomeChip | null;
  onKindChange?: (kind: HomeChip | null) => void;
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

/** The chat list orders (the top bar's sort), in menu order. */
export type ChatSort = 'recent' | 'unread' | 'az';

export const CHAT_SORT_DEFAULT: ChatSort = 'recent';

export const CHAT_SORT_OPTIONS: SortOption<ChatSort>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'unread', label: 'Unread first' },
  { value: 'az', label: 'A to Z' },
];

/** The useSort page key the chat list's order persists under. */
export const CHAT_SORT_PAGE = 'chat';

/** A stored sort value as a ChatSort: anything stale or unknown reads as Recent. Pure. */
export function chatSort(value: string): ChatSort {
  return value === 'unread' || value === 'az' ? value : CHAT_SORT_DEFAULT;
}

/**
 * Re-order a most-recent-first list for the chosen sort. Recent keeps it;
 * Unread first lifts the chats with something unread (each group keeps its
 * recency order); A to Z orders by the chat's display name (ties by id).
 * Personal notes (`notesId`) keeps its place: the index it holds in the
 * recent order, whatever the sort. Client-side over what the list already
 * holds; no read. Pure and stable.
 */
export function orderChannels(
  recent: readonly ChannelSummary[],
  sort: ChatSort,
  summaryFor: SummaryLookup,
  notesId: string | null = null,
): ChannelSummary[] {
  if (sort === 'recent') return [...recent];
  const notesAt = notesId !== null ? recent.findIndex((c) => c.channelId === notesId) : -1;
  const notes = notesAt !== -1 ? recent[notesAt] : undefined;
  const chats = recent.filter((c) => c.channelId !== notesId);
  const ordered =
    sort === 'unread'
      ? [
          ...chats.filter((c) => (summaryFor(c.channelId)?.unread ?? 0) > 0),
          ...chats.filter((c) => (summaryFor(c.channelId)?.unread ?? 0) <= 0),
        ]
      : [...chats].sort(
          (a, b) =>
            chatDisplayName(a).localeCompare(chatDisplayName(b), undefined, {
              sensitivity: 'base',
            }) || (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0),
        );
  if (notes === undefined) return ordered;
  return [...ordered.slice(0, notesAt), notes, ...ordered.slice(notesAt)];
}

/**
 * The rows the list shows, in the chosen order (most recent first by
 * default). A hidden chat (deleted for the caller, nothing newer since) is
 * left out.
 */
export function visibleChannels(
  channels: readonly ChannelSummary[],
  summaryFor: SummaryLookup,
  isHidden: HiddenLookup,
  sort: ChatSort = CHAT_SORT_DEFAULT,
  notesId: string | null = null,
): ChannelSummary[] {
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const recent = sortChannelsByRecency(channels, (id) => {
    const channel = byId.get(id);
    return { lastMessageTs: channel !== undefined ? recencyKey(channel, summaryFor) : 0 };
  }).filter((c) => !isHidden(c.channelId));
  return orderChannels(recent, sort, summaryFor, notesId);
}

/**
 * The list's layout classes. Locked (default): a full-height column whose body
 * scrolls itself. Page scroll (phone): the column and body grow with the rows
 * and the document scrolls them; the chip row
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

/** One action on the chat list's select bar (an old row menu row, or a chip view's action). */
export interface ChatSelectAction {
  id: 'hide' | 'forward' | 'delete';
  label: string;
  icon: ComponentType<IconProps>;
  onSelect: () => void;
  /** Destructive: bad ink. */
  bad?: boolean;
}

/**
 * The select bar's actions. Chats: Hide chat (the old row ⋮ menu's one row;
 * any count, non-destructive: eye-off, never red). A chip view selects
 * messages: Forward (when there is a forward path) and Delete for me (bad
 * ink); never Hide. Pure.
 */
export function chatSelectActions(select: ChannelSelectMode): ChatSelectAction[] {
  const media = select.media;
  if (media === undefined) {
    return [{ id: 'hide', label: 'Hide chat', icon: IconEyeOff, onSelect: select.onDelete }];
  }
  return [
    ...(media.onForward !== undefined
      ? [{ id: 'forward' as const, label: 'Forward', icon: IconForward, onSelect: media.onForward }]
      : []),
    {
      id: 'delete',
      label: DELETE_FOR_ME_LABEL,
      icon: IconTrash,
      onSelect: select.onDelete,
      bad: true,
    },
  ];
}

/**
 * The bottom bar in select mode (ui/SelectBar's anatomy, kept in the list's
 * own column so it never spans the thread pane on laptop): Cancel, the live
 * "N selected", then one 44 IconButton per action, each disabled at 0.
 */
function selectBar(select: ChannelSelectMode, className = ''): ReactElement {
  const count = select.selectedIds.size;
  return (
    <div
      data-chat-select-bar=""
      {...(select.media !== undefined ? { 'data-testid': 'media-select-bar' } : {})}
      role="toolbar"
      aria-label={select.media !== undefined ? 'Selected messages' : 'Selected chats'}
      className={cn('flex items-center gap-1 border-t bg-panel px-4 py-3 lit-dock', className)}
    >
      <Button type="button" variant="ghost" data-selection-cancel="" onClick={select.onCancel}>
        Cancel
      </Button>
      <span
        data-selection-count=""
        aria-live="polite"
        className={textRole('heading', 'min-w-0 flex-1 truncate')}
      >
        {selectCountLabel(count)}
      </span>
      {chatSelectActions(select).map((action) => (
        <IconButton
          key={action.id}
          label={action.label}
          data-selection-action={action.id}
          {...(action.id === 'forward' ? { 'data-selection-forward': '' } : {})}
          {...(action.id === 'delete' ? { 'data-selection-delete': '' } : {})}
          {...(action.id === 'hide' ? { 'data-selection-hide': '' } : {})}
          disabled={count === 0}
          className={action.bad === true ? 'text-bad hover:text-bad' : undefined}
          onClick={action.onSelect}
        >
          <action.icon size={ICON_SIZE.control} />
        </IconButton>
      ))}
    </div>
  );
}

/**
 * The full channel list pane: the shared SectionHeader (the filter chips, the
 * Select pinned at the chip row's end) above the body; New chat and the sort
 * live in the app top bar (ChannelList publishes them). While loading the body
 * is skeleton rows and on error a Retry state; rows and the empty state appear
 * only once the store is ready, already hidden-filtered and sorted. A chat's
 * long-press or right-click enters select mode with it ticked, as does a chip
 * view item's; the Select enters with nothing ticked. In select mode the
 * select bar sits under the body. Pure (no hooks) so the wiring and the
 * single-header guarantee are unit tested by walking the returned tree.
 */
export function channelListContent(props: ChannelListContentProps): ReactElement {
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const isHidden: HiddenLookup = props.isHidden ?? (() => false);
  const ready = props.status === 'ready';
  const hasChannels = ready && props.channels.some((c) => !isHidden(c.channelId));
  const select = ready ? props.select : undefined;
  const selecting = select?.active === true ? select : undefined;
  const kind = props.kind ?? null;
  // The chip row's Select: on the chat list and on a chip view alike.
  const sectionSelect =
    select !== undefined && hasChannels ? (
      <SectionSelect
        active={selecting !== undefined}
        onToggle={selecting !== undefined ? select.onCancel : select.onStart}
      />
    ) : undefined;
  const chipView = props.chipResults !== undefined && kind !== null;
  const onKindChange = props.onKindChange;
  const layout = channelListClasses(props.pageScroll === true);
  // Personal notes sorts in with the chats once the list is in; while it is
  // loading, failed or empty, its card sits above the body (from the session).
  const notesInList = props.notes !== undefined && hasChannels;
  const listed =
    notesInList && props.notes !== undefined ? [...props.channels, props.notes] : props.channels;
  return (
    <div className={layout.column}>
      <div className={cn('border-b border-border pb-3', layout.header)}>
        <SectionHeader {...(sectionSelect !== undefined ? { select: sectionSelect } : {})}>
          {onKindChange !== undefined ? searchChips({ kind, onChange: onKindChange }) : undefined}
        </SectionHeader>
      </div>
      <div className={layout.body}>
        {props.lead !== undefined && !chipView ? props.lead : null}
        {props.notes !== undefined && !chipView && !notesInList
          ? notesTile({
              notes: props.notes,
              summary: summaryFor(props.notes.channelId),
              nowMs: props.nowMs ?? 0,
              timeZone: props.timeZone,
              selected: props.notes.channelId === props.selectedChannelId,
              selecting: selecting !== undefined,
              onSelect: props.onSelect,
              ownName: props.ownName,
            })
          : null}
        <SettleLanding boxes={props.status === 'loading'} selector="[data-chat-home] li">
          {props.status === 'loading'
            ? channelListSkeleton()
            : props.status === 'error'
              ? channelListError(props.onRetry)
              : chipView
                ? props.chipResults
                : channelListView({
                    channels: visibleChannels(
                      listed,
                      summaryFor,
                      isHidden,
                      props.sort ?? CHAT_SORT_DEFAULT,
                      notesInList && props.notes !== undefined ? props.notes.channelId : null,
                    ),
                    ...(notesInList && props.notes !== undefined ? { notes: props.notes } : {}),
                    hasChannels,
                    selectedChannelId: props.selectedChannelId,
                    onSelect: props.onSelect,
                    ...(props.onPressIn !== undefined ? { onPressIn: props.onPressIn } : {}),
                    onNewChat: props.onNewChat,
                    summaryFor,
                    ...(props.draftFor !== undefined ? { draftFor: props.draftFor } : {}),
                    // The chat cards' select mode (a chip view's bar selects
                    // messages, so the cards are not shown then).
                    ...(select !== undefined && select.media === undefined
                      ? {
                          select: {
                            active: selecting !== undefined,
                            selectedIds: select.selectedIds,
                            onEnter: select.onEnter,
                            onToggle: select.onToggle,
                          },
                        }
                      : {}),
                    ...(props.ownName !== undefined ? { ownName: props.ownName } : {}),
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

/**
 * Scrollable channel list pane under the chip row. It is the Chat route's
 * list (ChatConnected mounts it only there: the phone's list screen, the
 * laptop's list pane), so it publishes New chat and the sort into the app top
 * bar; on the phone a thread replaces it and the bar clears with it.
 */
export function ChannelList(props: ChannelListProps): ReactElement {
  const listWorkspaceId = props.workspaceId ?? null;
  // The list order: persisted per page like the other sorts; a stale value heals.
  const { value: storedSort, setValue: setSort } = useSort<ChatSort>(
    CHAT_SORT_PAGE,
    CHAT_SORT_DEFAULT,
  );
  const sort = chatSort(storedSort);
  // The filter chip: one at a time, tap again to clear.
  const [kind, setKind] = useState<HomeChip | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // A chip view selects items by message (message id to chat id).
  const [mediaSelection, setMediaSelection] = useState<MediaSelection>(EMPTY_MEDIA_SELECTION);
  // The chip view's forward picker: the messages to forward, or null (closed).
  const [forwardItems, setForwardItems] = useState<readonly HideItem[] | null>(null);
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
  const exitSelect = (): void => {
    setSelecting(false);
    setSelectedIds(new Set());
    setMediaSelection(EMPTY_MEDIA_SELECTION);
  };

  // Hide chat (the select bar, any count): no confirm. The chats leave
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

  // A chip lists its items through the message search runner (the chip alone,
  // no words). Names come from the loaded roster and the workspace's name
  // registry, never per row.
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
    searchRunner?.setQuery('', kind);
  }, [searchRunner, kind]);
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
  // The header stays up while selecting: a new chip leaves select mode first
  // (the ticked chats or items may no longer be on screen).
  const onKindChange = useCallback((next: HomeChip | null) => {
    if (next !== null) mark('chat:chip:tap');
    setSelecting(false);
    setSelectedIds(new Set());
    setMediaSelection(EMPTY_MEDIA_SELECTION);
    setKind(next);
  }, []);
  // Items in notes carry its name ("Personal notes").
  const notes = props.notes;
  const channelsById = useMemo(() => {
    const byId = new Map(props.channels.map((c) => [c.channelId, c] as const));
    if (notes !== undefined) byId.set(notes.channelId, notes);
    return byId;
  }, [props.channels, notes]);
  const nameOf = useMemo(() => mentionNamesIn(listWorkspaceId), [listWorkspaceId]);
  const onOpenAtMessage = props.onOpenAtMessage;
  // The list's one clock: every card's "5m" ages together, once a
  // minute, from one shared interval (no timer per card).
  const nowMs = useMinuteClock();
  // A chip view item's long-press or right-click: select mode with that item ticked.
  const enterMediaSelect =
    onDeleteChats !== undefined
      ? (item: HideItem): void => {
          setSelectedIds(new Set());
          setMediaSelection(toggleMediaSelection(EMPTY_MEDIA_SELECTION, item));
          setSelecting(true);
        }
      : undefined;
  const chipResults =
    mediaKind !== null ? (
      <MediaResults
        kind={mediaKind}
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
        {...(enterMediaSelect !== undefined ? { onEnterSelect: enterMediaSelect } : {})}
        {...(canForward
          ? { onForwardItems: setForwardItems, forwarding: forwardItems !== null }
          : {})}
        {...(currentUserId !== null && listWorkspaceId !== null
          ? { onDeleteForMe: deleteForMe }
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
    ) : undefined;
  // The top bar: the sort and New chat. New chat leaves the list's select
  // mode, and a thread selecting messages exits that first (history.back()).
  // The latest New chat through a ref, so the published "+" stays one element.
  const onNewChatRef = useRef(props.onNewChat);
  onNewChatRef.current = props.onNewChat;
  const newChat = useCallback((): void => {
    setSelecting(false);
    setSelectedIds(new Set());
    setMediaSelection(EMPTY_MEDIA_SELECTION);
    leaveSelectionThen(() => onNewChatRef.current());
  }, []);
  const sortNode = useMemo(
    () => (
      <SortMenu options={CHAT_SORT_OPTIONS} value={sort} onChange={setSort} label="Sort chats" />
    ),
    [sort, setSort],
  );
  const plusNode = useMemo(() => <TopbarPlus label="New chat" onClick={newChat} />, [newChat]);
  useTopbarActions({ sort: sortNode, primary: plusNode });
  return (
    <>
      {channelListContent({
        ...props,
        input,
        sort,
        kind,
        onKindChange,
        ...(chipResults !== undefined ? { chipResults } : {}),
        summaryFor,
        isHidden,
        draftFor,
        nowMs,
        // Personal notes' picture: the caller's own initials when there is no photo.
        ...(currentUserId !== null ? { ownName: personName(listWorkspaceId, currentUserId) } : {}),
        ...(onDeleteChats !== undefined
          ? {
              select: {
                active: selecting,
                selectedIds: mediaSelecting ? new Set(mediaSelection.keys()) : selectedIds,
                // A chat's long-press or right-click: select mode with that chat ticked.
                onEnter: (channelId: string) => {
                  setMediaSelection(EMPTY_MEDIA_SELECTION);
                  setSelectedIds(new Set([channelId]));
                  setSelecting(true);
                },
                // The chip row's Select: nothing ticked yet.
                onStart: () => {
                  setSelectedIds(new Set());
                  setMediaSelection(EMPTY_MEDIA_SELECTION);
                  setSelecting(true);
                },
                onCancel: exitSelect,
                // Unticking the last chat leaves select mode.
                onToggle: (channelId: string) => {
                  const next = new Set(selectedIds);
                  if (next.has(channelId)) next.delete(channelId);
                  else next.add(channelId);
                  if (next.size === 0) exitSelect();
                  else setSelectedIds(next);
                },
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
