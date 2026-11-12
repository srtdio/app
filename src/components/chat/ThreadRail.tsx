// The thread rail of a card's iMessage-style thread, drawn per row from
// classes alone (no measurement after paint, no motion): a through line spans
// a row's whole box at x=16, a member's tick and a root's or chip's elbow are
// anchored to their target's vertical middle, so the pieces join with no gap
// at any row spacing. Plus the rows the rail heads or passes: the chip over a
// run whose root card is not right above it, "N replies" under a root card,
// and the thread view's "N replies" line. A 2px stroke in the stronger border
// token, round caps and joins; tokens only, so light and dark are at parity.
// Every control carries the rows' long-press guard (no text selection, no
// callout).

import type { ReactElement } from 'react';
import { ICON_SIZE, IconChat, IconForward, IconTodo, RailCurveGlyph } from '@/components/ui/icons';
import { ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { IconButton } from '@/components/ui/IconButton';
import { Text, textRole } from '@/components/ui/Text';
import { INK_TRAILING_LAST, TRAILING_PULL } from '@/components/ui/layout';
import { ADD_TO_TASKS_LABEL, MORE_ACTIONS_LABEL } from '@/components/chat/MessageActionMenu';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import {
  MESSAGE_PHOTO_COL,
  NO_TOUCH_SELECT,
  REPLIES_ROW_PAD,
  sized,
  useChatLayout,
} from '@/components/chat/chat-type';
import { PostRefThumb, type PostRefPost } from '@/components/chat/PostRefChip';
import { replyCountLabel } from '@/lib/chat/thread-rail';
import { Avatar } from '@/components/ui/Avatar';
import { LIST_CARD_UNREAD_DOT } from '@/components/ui/ListCard';

/** The rail's ink: the stronger border token. */
const RAIL_INK = 'bg-border-strong';

/** The rail through a row's whole box (x=16), for a member above and below it. */
export function RailThrough(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-rail="through"
      className={cn('pointer-events-none absolute bottom-0 left-[15px] top-0 w-0.5', RAIL_INK)}
    />
  );
}

/**
 * A member's tick, inside its target (photo or bubble wrapper): the rail from
 * the row's top edge down, a curve off it, then across into the target's left
 * edge at its vertical middle. `reach` is the width from the rail to the
 * target; `top` reaches up through the row's top padding.
 */
export function RailTick(props: { reach: string; top: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-rail="tick"
      className={cn(
        'pointer-events-none absolute bottom-[calc(50%-1px)] right-full',
        props.reach,
        props.top,
      )}
    >
      <span className={cn('absolute bottom-3 left-0 top-0 w-0.5', RAIL_INK)} />
      <RailCurveGlyph turn="tick" className="bottom-0 left-0" />
      <span className={cn('absolute bottom-0 left-[13px] right-0 h-0.5', RAIL_INK)} />
    </span>
  );
}

/**
 * The rail's top, inside a root card or chip: from the target's left edge at
 * its vertical middle across to the rail, a curve down, then the rail down
 * through the row's bottom edge (`bottom` reaches through its bottom padding).
 */
export function RailElbow(props: { reach: string; bottom: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-rail="elbow"
      className={cn(
        'pointer-events-none absolute right-full top-[calc(50%-1px)]',
        props.reach,
        props.bottom,
      )}
    >
      <span className={cn('absolute left-[13px] right-0 top-0 h-0.5', RAIL_INK)} />
      <RailCurveGlyph turn="elbow" className="left-0 top-0" />
      <span className={cn('absolute bottom-0 left-0 top-3 w-0.5', RAIL_INK)} />
    </span>
  );
}

/** Cancel the native default (the touch contextmenu on thread controls). */
function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/** A thread chip's two parts: the post title and its reply count. */
interface ThreadChipLabel {
  title: string;
  count: string | null;
}

/** A thread chip's line: "title · N replies" (the count only when it is known). */
export function threadChipLabel(input: { title: string; count: number | null }): ThreadChipLabel {
  return { title: input.title, count: replyCountLabel(input.count) };
}

/** The touch callout and text selection stay off every thread control (the rows' guard). */
function guardProps(coarse: boolean): {
  onContextMenu?: (event: { preventDefault: () => void }) => void;
} {
  return coarse ? { onContextMenu: preventDefault } : {};
}

/**
 * The chip heading a run whose root card is not right above it (not loaded,
 * or the run was broken): 28px tall, radius 14, panel fill, 20px thumbnail at
 * a 5px radius, "title · N replies" at 12px, inside a 44px target at the
 * member indent (30px). The rail's top joins its left edge. Tap opens the
 * thread. No motion.
 */
export function ThreadChipRow(props: {
  post: PostRefPost | null;
  count: number | null;
  coarse: boolean;
  onOpen: () => void;
}): ReactElement {
  const { post } = props;
  const label = threadChipLabel({
    title: post?.title ?? 'Shared post',
    count: props.count,
  });
  return (
    <li
      data-thread-chip=""
      className={cn('relative flex min-w-0 pl-[30px] pr-4 pt-3', NO_TOUCH_SELECT)}
      {...guardProps(props.coarse)}
    >
      <span className="relative flex min-w-0 max-w-full">
        <RailElbow reach="w-[15px]" bottom="bottom-0" />
        <PressableRow
          inline
          type="button"
          data-thread-open="chip"
          aria-label={`Open the thread about ${label.title}`}
          onClick={props.onOpen}
          className={cn('flex min-w-0 max-w-full items-center', NO_TOUCH_SELECT)}
        >
          <span className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full bg-panel px-3 py-2 text-sm lit-pill">
            <PostRefThumb assetVersionId={post?.thumbnailAssetVersionId ?? null} size={20} />
            <span className="min-w-0 truncate text-fg-2">{label.title}</span>
            {label.count !== null ? (
              <span data-thread-chip-count="" className="shrink-0 text-fg-3">
                · {label.count}
              </span>
            ) : null}
          </span>
        </PressableRow>
      </span>
    </li>
  );
}

/** Where "N replies" sits under a card: the card's left edge (16 plus the shift, past a photo in groups). */
const REPLIES_INDENT: Record<'dm' | 'group', Record<0 | 14, string>> = {
  dm: { 0: 'pl-4', 14: 'pl-[30px]' },
  group: { 0: 'pl-[50px]', 14: 'pl-16' },
};

/**
 * "N replies" under a root card: a 44px button, 13px semibold in the accent
 * text token, on the card's side (right for an own card, at the card's left
 * edge for others). Tap opens the thread. Hidden at 0 (the caller renders
 * nothing). The rail runs through it when a member follows.
 */
export function RepliesButtonRow(props: {
  label: string;
  mine: boolean;
  isGroup: boolean;
  shifted: boolean;
  through: boolean;
  coarse: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <li
      data-thread-replies=""
      className={cn(
        'relative flex pr-4',
        props.mine
          ? 'justify-end pl-4'
          : REPLIES_INDENT[props.isGroup ? 'group' : 'dm'][props.shifted ? 14 : 0],
        NO_TOUCH_SELECT,
      )}
      {...guardProps(props.coarse)}
    >
      {props.through ? <RailThrough /> : null}
      <PressableRow
        inline
        type="button"
        data-thread-open="replies"
        onClick={props.onOpen}
        className={cn('flex items-center text-md font-semibold text-accent', NO_TOUCH_SELECT)}
      >
        {props.label}
      </PressableRow>
    </li>
  );
}

/** What the thread view's divider does to the ROOT message; an absent action is hidden. */
export interface RootActions {
  /** Add to Tasks: the long-press sheet's own Add to Tasks. */
  onTasks?: (() => void) | undefined;
  /** Forward: the Forward picker for the root. */
  onForward?: (() => void) | undefined;
  /** More actions: the root's long-press sheet, anchored on the tapped button. */
  onMore?: ((from: HTMLElement) => void) | undefined;
}

/** Where a thread strip sits: the host's row inset and photo-to-text gap (rule 1: label on the text column). */
export const THREAD_STRIP_COLUMNS: Record<'chat' | 'catch-up', { x: string; gap: string }> = {
  // Phone: 12 after the 36 icon column, so "Reply in thread" starts on 64.
  chat: { x: 'px-4', gap: 'gap-2 max-md:gap-3' },
  'catch-up': { x: 'px-4', gap: 'gap-3' },
};

/** The strip's label with no replies yet. */
export const REPLY_IN_THREAD = 'Reply in thread';

/** Keep focus where it is (the reply box) when the strip is pressed. */
function keepFocus(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * The one thread strip (9 Nov 2026) under a thread's root, in chat's thread
 * view and catch up's: a full width band between two hairlines, 44 tall at
 * least, a faint fg tint (the catch-up name row's family; a token, so light
 * and dark at parity). Left: a 32 icon column (chat bubble, fg-2) on the
 * photo column, then the label on the message text column. No replies:
 * "Reply in thread" (fg-2); a tap focuses the thread's reply box (pointerdown
 * keeps focus off the strip so the keyboard opens). Replies: "N replies"
 * (ink), not a target. Right: the root's keys (Add to Tasks, Forward, More),
 * 44 each, the last pulled out by 12 (TRAILING_PULL) onto the content edge.
 */
export function RepliesSeparatorRow(props: {
  /** "N replies", or null for none yet ("Reply in thread"). */
  label: string | null;
  through: boolean;
  actions?: RootActions | undefined;
  coarse?: boolean | undefined;
  family?: 'chat' | 'catch-up' | undefined;
  /** No replies: focus the thread's reply box. */
  onFocusReply?: (() => void) | undefined;
  as?: 'li' | 'div' | undefined;
  /** The host's spacing around the strip (12 above, 8 below its content). */
  className?: string | undefined;
}): ReactElement {
  const actions = props.actions ?? {};
  const cols = THREAD_STRIP_COLUMNS[props.family ?? 'chat'];
  const empty = props.label === null;
  const label = props.label ?? REPLY_IN_THREAD;
  const Tag = props.as ?? 'li';
  const focusable = empty && props.onFocusReply !== undefined;
  return (
    <Tag
      aria-label={label}
      data-thread-separator=""
      data-thread-replies-divider=""
      data-thread-strip={empty ? 'empty' : 'replies'}
      className={cn(
        'relative flex min-h-11 items-center border-y border-border bg-fg/[0.03]',
        cols.x,
        NO_TOUCH_SELECT,
        props.className,
      )}
      {...guardProps(props.coarse === true)}
    >
      {props.through ? <RailThrough /> : null}
      {focusable ? (
        <PressableRow
          flat
          insetFocus
          type="button"
          data-thread-strip-focus=""
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={props.onFocusReply}
          className={cn('flex min-w-0 flex-1 items-center', cols.gap, NO_TOUCH_SELECT)}
        >
          <StripLead label={label} empty />
        </PressableRow>
      ) : (
        <span className={cn('flex min-w-0 flex-1 items-center', cols.gap)}>
          <StripLead label={label} empty={empty} />
        </span>
      )}
      {/* Phone: the last key's glyph slides so its ink ends on the 16 edge. */}
      <span className={cn('flex shrink-0 items-center', TRAILING_PULL, INK_TRAILING_LAST)}>
        {actions.onTasks !== undefined ? (
          <IconButton
            type="button"
            label={ADD_TO_TASKS_LABEL}
            data-thread-root-action="tasks"
            onClick={actions.onTasks}
          >
            <IconTodo size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        {actions.onForward !== undefined ? (
          <IconButton
            type="button"
            label="Forward"
            data-thread-root-action="forward"
            onClick={actions.onForward}
          >
            <IconForward size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        {actions.onMore !== undefined ? (
          <ActionMenuTrigger
            type="button"
            edge="free"
            label={MORE_ACTIONS_LABEL}
            data-thread-root-action="more"
            onClick={(event) => actions.onMore?.(event.currentTarget)}
          />
        ) : null}
      </span>
    </Tag>
  );
}

/**
 * The strip's lead (9 Nov 2026). Replies: "N replies" semibold ink on the 16
 * gutter, no icon. None: the bubble icon (the photo column: 36 touch, 32
 * laptop) and "Reply in thread".
 */
function StripLead(props: { label: string; empty: boolean }): ReactElement {
  const layout = useChatLayout();
  if (!props.empty) {
    return (
      <span
        data-thread-strip-label=""
        className={textRole('label', 'min-w-0 truncate font-semibold text-fg')}
      >
        {props.label}
      </span>
    );
  }
  return (
    <>
      <span
        aria-hidden="true"
        data-thread-strip-icon=""
        className={cn('flex shrink-0 justify-center text-fg-2', sized(MESSAGE_PHOTO_COL, layout))}
      >
        <IconChat size={ICON_SIZE.control} />
      </span>
      <span data-thread-strip-label="" className={textRole('label', 'min-w-0 truncate text-fg-2')}>
        {props.label}
      </span>
    </>
  );
}

/**
 * The replies row under a thread root in the main chat (9 Nov 2026; the
 * work-chat layout, aligned under the root's text: photo 36 + gap 12 touch,
 * 32 + 8 laptop, REPLIES_ROW_PAD). Up to 3
 * square photos (32) of the latest repliers, the latest last (next to the count), "N replies"
 * (semibold ink, never truncates), the last reply's time (rowWhen, fg-3, the
 * first thing to truncate) and an 8px ink dot while a reply is unread by me;
 * 8 between each. No reply text. The whole row is one 44 tall target that
 * opens the thread. Tokens only; light and dark at parity.
 */
export function RepliesRow(props: {
  label: string;
  repliers: readonly { id: string; name: string; src?: string | undefined }[];
  /** The last reply's time ("Today at 10:12 AM"); '' hides it. */
  time: string;
  unread: boolean;
  coarse: boolean;
  onOpen: () => void;
}): ReactElement {
  const layout = useChatLayout();
  return (
    <li
      data-replies-row=""
      data-unread={props.unread ? '' : undefined}
      className={cn('flex min-w-0 pr-4', sized(REPLIES_ROW_PAD, layout), NO_TOUCH_SELECT)}
      {...guardProps(props.coarse)}
    >
      <PressableRow
        inline
        type="button"
        data-thread-open="replies"
        aria-label={`${props.label}${props.time !== '' ? `, last reply ${props.time}` : ''}${props.unread ? ', unread' : ''}. Open thread`}
        onClick={props.onOpen}
        className={cn('flex min-h-11 min-w-0 max-w-full items-center gap-2 px-2', NO_TOUCH_SELECT)}
      >
        {props.repliers.length > 0 ? (
          <span data-replies-photos="" className="flex shrink-0 items-center gap-1">
            {props.repliers.map((r) => (
              <Avatar
                key={r.id}
                role="stack"
                name={r.name}
                {...(r.src !== undefined ? { src: r.src } : {})}
                decorative
              />
            ))}
          </span>
        ) : null}
        <span data-replies-count="" className="shrink-0 text-md font-semibold text-fg">
          {props.label}
        </span>
        {props.time !== '' ? (
          <span
            data-replies-time=""
            className="min-w-0 truncate font-mono text-sm tabular-nums text-fg-3"
          >
            {props.time}
          </span>
        ) : null}
        {props.unread ? (
          <span aria-hidden="true" data-replies-dot="" className={LIST_CARD_UNREAD_DOT} />
        ) : null}
      </PressableRow>
    </li>
  );
}

/**
 * A thread view's root head in catch up (9 Nov 2026; chat's root draws the
 * same on laptop only, MessageBubble rootStack): the 40 square photo on the 16
 * gutter, 12 to the name (line 1) over its threadWhen 'date' time (line 2).
 * The root's text sits full width below it, on the gutter too. Chat's phone
 * root is a normal head row instead (36 photo, text on the 64 column); catch
 * up's thread still stacks on phone until CatchUpThreadView draws a head row.
 */
export function ThreadRootHead(props: {
  name: string;
  avatarUrl: string | null;
  when: string;
  dateTime: string;
}): ReactElement {
  return (
    // Phone: 8 after the 40 photo, so the name and its time start on 64.
    <div data-thread-root-head="" className="flex min-w-0 items-center gap-3 max-md:gap-2">
      <Avatar
        role="row"
        name={props.name}
        {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
        decorative
      />
      <span className="flex min-w-0 flex-col">
        <span
          data-sender-name=""
          className={textRole('label', 'min-w-0 truncate font-semibold text-fg')}
        >
          {props.name}
        </span>
        <Text role="meta" as="time" dateTime={props.dateTime} data-sender-time="">
          {props.when}
        </Text>
      </span>
    </div>
  );
}
