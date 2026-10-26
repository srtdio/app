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
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { PostRefThumb, type PostRefPost } from '@/components/chat/PostRefChip';
import { replyCountLabel } from '@/lib/chat/thread-rail';

/** The rail's ink: the stronger border token. */
const RAIL_INK = 'bg-border-strong';

/** A 12px-radius quarter curve of the rail, round caps and joins. */
function RailCurve(props: { d: string; className: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 13 13"
      fill="none"
      className={cn(
        'absolute h-[13px] w-[13px] overflow-visible text-border-strong',
        props.className,
      )}
    >
      <path
        d={props.d}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The rail through a row's whole box (x=16), for a member above and below it. */
export function RailThrough(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-rail="through"
      className={cn('pointer-events-none absolute bottom-0 left-[15px] top-0 w-[2px]', RAIL_INK)}
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
      <span className={cn('absolute bottom-3 left-0 top-0 w-[2px]', RAIL_INK)} />
      <RailCurve d="M1 0A12 12 0 0 0 13 12" className="bottom-0 left-0" />
      <span className={cn('absolute bottom-0 left-[13px] right-0 h-[2px]', RAIL_INK)} />
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
      <span className={cn('absolute left-[13px] right-0 top-0 h-[2px]', RAIL_INK)} />
      <RailCurve d="M13 1A12 12 0 0 0 1 13" className="left-0 top-0" />
      <span className={cn('absolute bottom-0 left-0 top-3 w-[2px]', RAIL_INK)} />
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
      className={cn('relative flex min-w-0 pl-[30px] pr-4 pt-2.5', NO_TOUCH_SELECT)}
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
          <span className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-panel pl-1 pr-2.5 text-sm">
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
  group: { 0: 'pl-[50px]', 14: 'pl-[64px]' },
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

/** The thread view's "N replies" line under its root: 12px muted, centred, not a button. */
export function RepliesSeparatorRow(props: { label: string; through: boolean }): ReactElement {
  return (
    <li
      role="separator"
      aria-label={props.label}
      data-thread-separator=""
      className={cn('relative flex justify-center px-4 py-2', NO_TOUCH_SELECT)}
    >
      {props.through ? <RailThrough /> : null}
      <span className="text-sm text-fg-3">{props.label}</span>
    </li>
  );
}
