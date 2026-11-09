// The emoji reaction chips (9 Nov 2026): the ONE row every place text lives
// draws under its text (post / brief comments, plan comments, chat main,
// thread root and replies, catch-up cards and their thread view; never
// Activity). A pill per emoji, in order of first reaction: h-8, rounded-full,
// a 1px border, px-2, gap-1 inside, gap-2 between; the emoji at lg, the count
// at sm tabular. Others: border + a faint fg wash, count fg-2. Mine: a darker
// ink border and wash, count medium fg. Ink only. The last pill is the smiley
// ("Add reaction", w-10), opening the one emoji drawer (ui/EmojiSheet titled
// "Add reaction"). 44 tall taps come from a pseudo-element (before:-inset-y-1.5),
// never from growing the pill. Tap a pill = toggle mine. Long-press (phone) =
// who reacted (chat's sheet); hover (laptop) = a small popover with the names.
// No reactions: nothing renders. Pure
// render on paint: the drawer chunk and any who-reacted read start on a tap.

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';
import { ICON_SIZE, IconSmile } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui/useLongPress';
import { WhoReactedSheet } from '@/components/chat/ReadingLayer';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { useHoverPointer } from '@/lib/use-is-laptop';
import {
  ADD_REACTION_LABEL,
  ADD_REACTION_TITLE,
  reactionChipLabel,
  type ReactionSummary,
} from '@/lib/reactions/model';
import type { WhoReactedData } from '@/lib/reactions/reads';

const EmojiSheet = lazy(() => import('@/components/ui/EmojiSheet'));

/** The row: wraps, 8 between pills. */
export const REACTION_ROW_CLASS = 'flex flex-wrap items-center gap-2';

/** Every pill: 32 tall, a hairline, 44 tall taps from the ::before. */
export const REACTION_PILL_CLASS =
  "relative inline-flex h-8 shrink-0 items-center rounded-full border before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] focus-visible:lit-focus";

/** Someone else's chip, and mine. */
export const REACTION_PILL_OTHERS = 'border-border bg-fg/[0.04]';
export const REACTION_PILL_MINE = 'border-fg/70 bg-fg/[0.08]';

/** Who reacted to one target: chat's reader shape (rows plus names). */
export type ReactionWhoLoad = () => Promise<Result<WhoReactedData>>;

/** The drawer for a reaction: the one emoji sheet, titled "Add reaction"; its chunk loads on first open. */
export function AddReactionSheet(props: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}): ReactElement | null {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <EmojiSheet
        open={props.open}
        onClose={props.onClose}
        onPick={props.onPick}
        closeOnPick
        title={ADD_REACTION_TITLE}
      />
    </Suspense>
  );
}

/** Names per emoji from a who-reacted read ("You" for the viewer, first). Pure. */
export function namesByEmoji(data: WhoReactedData, viewerId: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of data.rows) {
    const mine = viewerId !== null && row.userId === viewerId;
    const name = mine ? 'You' : (data.profiles.get(row.userId)?.displayName ?? '');
    if (name === '') continue;
    const list = out.get(row.emoji) ?? [];
    if (mine) list.unshift(name);
    else list.push(name);
    out.set(row.emoji, list);
  }
  return out;
}

/** One pill: tap toggles; hold (touch) opens who reacted; hover (laptop) shows names. */
function ReactionPill(props: {
  reaction: ReactionSummary;
  onToggle: () => void;
  onHold: (() => void) | null;
  hover: boolean;
  names: readonly string[] | null;
  onHover: (() => void) | null;
}): ReactElement {
  const { reaction } = props;
  const [hovering, setHovering] = useState(false);
  const holdRef = useRef(props.onHold);
  holdRef.current = props.onHold;
  const press = useLongPress(() => holdRef.current?.(), { ignoreMouse: true });
  const names = props.names;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-reaction-chip={reaction.emoji}
        data-mine={reaction.mine ? '' : undefined}
        aria-pressed={reaction.mine}
        aria-label={reactionChipLabel(reaction)}
        {...(props.onHold !== null ? press.handlers : {})}
        onContextMenu={props.onHold !== null ? (event) => event.preventDefault() : undefined}
        onPointerEnter={
          props.hover
            ? () => {
                setHovering(true);
                props.onHover?.();
              }
            : undefined
        }
        onPointerLeave={props.hover ? () => setHovering(false) : undefined}
        onClick={() => {
          if (press.consumeClickSuppression()) return;
          props.onToggle();
        }}
        className={cn(
          REACTION_PILL_CLASS,
          'gap-1 px-2',
          reaction.mine ? REACTION_PILL_MINE : REACTION_PILL_OTHERS,
          MOVE_CLASS.press,
        )}
      >
        <span aria-hidden="true" className="text-lg">
          {reaction.emoji}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'text-sm tabular-nums',
            reaction.mine ? 'font-medium text-fg' : 'text-fg-2',
          )}
        >
          {reaction.count}
        </span>
      </button>
      {hovering && names !== null && names.length > 0 ? (
        <span
          role="tooltip"
          data-reaction-who=""
          className="pointer-events-none absolute bottom-full left-0 z-sheet mb-2 w-max max-w-64 rounded-lg border bg-panel px-3 py-2 text-sm text-fg lit-float"
        >
          {names.join(', ')}
        </span>
      ) : null}
    </span>
  );
}

export interface ReactionChipsProps {
  reactions: readonly ReactionSummary[];
  /** A pill tap: toggle the viewer's reaction with that emoji. */
  onToggle: (emoji: string) => void;
  /** A drawer pick (the smiley pill's sheet). */
  onPick: (emoji: string) => void;
  /** Who reacted (long-press sheet, laptop hover); absent: neither. */
  who?: { load: ReactionWhoLoad; viewerId: string | null; targetId: string } | undefined;
  /** Phone long-press: the host's own who-reacted sheet (chat's); absent: this row's sheet. */
  onWho?: ((emoji: string) => void) | undefined;
  /** Off: draw the chips only (no smiley; a row that cannot take a reaction). */
  canReact?: boolean;
  className?: string;
}

export function ReactionChips(props: ReactionChipsProps): ReactElement | null {
  const { reactions, who } = props;
  const canReact = props.canReact !== false;
  const hover = useHoverPointer();
  const [drawer, setDrawer] = useState(false);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string[]> | null>(null);
  const asked = useRef(false);
  // A new set of reactions makes the held names stale.
  const signature = reactions.map((r) => `${r.emoji}${r.count}`).join(' ');
  useEffect(() => {
    asked.current = false;
    setNames(null);
  }, [signature]);
  if (reactions.length === 0) return null;
  const loadNames = (): void => {
    if (who === undefined || asked.current) return;
    asked.current = true;
    void who.load().then((result) => {
      if (result.ok) setNames(namesByEmoji(result.data, who.viewerId));
      else asked.current = false;
    });
  };
  return (
    <div data-reaction-chips="" className={cn(REACTION_ROW_CLASS, props.className)}>
      {reactions.map((reaction) => (
        <ReactionPill
          key={reaction.emoji}
          reaction={reaction}
          onToggle={() => {
            if (canReact) props.onToggle(reaction.emoji);
          }}
          onHold={
            hover
              ? null
              : props.onWho !== undefined
                ? () => props.onWho?.(reaction.emoji)
                : who !== undefined
                  ? () => setSheetFor(who.targetId)
                  : null
          }
          hover={hover && who !== undefined}
          names={names?.get(reaction.emoji) ?? null}
          onHover={loadNames}
        />
      ))}
      {canReact ? (
        <button
          type="button"
          data-reaction-add=""
          aria-label={ADD_REACTION_LABEL}
          aria-haspopup="dialog"
          onClick={() => setDrawer(true)}
          className={cn(
            REACTION_PILL_CLASS,
            REACTION_PILL_OTHERS,
            // 40 wide: its ::before runs 2 past each side, so the tap is 44 x 44.
            'w-10 justify-center text-fg-2 before:-inset-x-0.5',
            MOVE_CLASS.press,
          )}
        >
          <IconSmile size={ICON_SIZE.inline} />
        </button>
      ) : null}
      <AddReactionSheet
        open={drawer}
        onClose={() => setDrawer(false)}
        onPick={(emoji) => props.onPick(emoji)}
      />
      {who !== undefined && sheetFor !== null ? (
        <WhoReactedSheet
          messageId={sheetFor}
          onClose={() => setSheetFor(null)}
          viewerId={who.viewerId}
          load={() => who.load()}
          onRemove={(_id, emoji) => props.onToggle(emoji)}
        />
      ) : null}
    </div>
  );
}
