// The composer's plus button and its tray (replaces the paperclip). The button
// is a 44x44 circle on the panel; while the tray is open it turns accent and
// its plus rotates 45deg into an X (rotate only). The tray sits above the
// composer: a 4-column grid of tiles (Photos, File, Assets, Brief, Post, Draft,
// Plan, Schedule on touch and laptop alike) that slides on translateY and fades,
// 180ms, no X and no scale. A tap outside, Escape, or picking a tile closes it.
// Photos / File run the composer's attach paths (the Photos picker still offers
// Take Photo on phones); Assets opens the library picker; Brief, Post and Draft
// open the share picker in that mode; Plan opens the New plan screen; Schedule
// opens the Schedule sheet. Draft is live only for an agency-side viewer in a
// chat with no client, Plan only for an agency-side viewer: otherwise (or while
// either is unknown) they render faded and disabled from the first frame. Tokens only, so light and dark stay at parity.

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import {
  IconBriefs,
  IconCalendarClock,
  IconDraft,
  IconFile,
  IconFolder,
  IconImage,
  IconPipeline,
  IconPlan,
  IconPlus,
} from '@/components/ui/icons';
import { isClient } from '@/components/pages/pcs/roles';
import { cn } from '@/lib/cn';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { NO_TOUCH_SELECT, type ChatLayout } from '@/components/chat/chat-type';

/** The tray and the plus icon move for this long. */
export const TRAY_MOTION_MS = 180;

type TileIcon = ComponentType<{ size?: number; className?: string }>;

/** Every tray tile id, in display order. */
export type TrayTileId =
  | 'photos'
  | 'file'
  | 'assets'
  | 'brief'
  | 'post'
  | 'draft'
  | 'plan'
  | 'schedule';

/** One tray tile. A disabled tile renders faded, has no tap action and says why. */
export interface TrayTile {
  id: TrayTileId;
  label: string;
  Icon: TileIcon;
  disabled?: true;
  /** The accessible name when it differs from the label (a disabled Draft says why). */
  ariaLabel?: string;
}

/** The disabled Draft tile's accessible name. */
export const DRAFT_UNAVAILABLE_LABEL = 'Draft, not available in chats with clients';

/** The disabled Plan tile's accessible name. */
export const PLAN_UNAVAILABLE_LABEL = 'Plan, only the agency team can share a plan';

/** The Plan tile's accessible name in Personal notes (a plan is shared into a chat). */
export const PLAN_NOTES_LABEL = 'Plan, not available in Personal notes';

/**
 * Whether the open chat has a client among its other active members: null
 * while the member list is loading or failed (unknown), never true or false on
 * a guess. The viewer is never in the list; their own side is read apart. Pure.
 */
export function channelHasClient(
  members: ReadonlyArray<{ role: string | null }> | null,
): boolean | null {
  if (members === null) return null;
  return members.some((member) => isClient(member.role));
}

/**
 * Whether the Draft tile is live: an agency-side viewer in a chat with no
 * client, both known. Anything unknown keeps it disabled. Pure.
 */
export function draftTileEnabled(side: ViewerSide, hasClient: boolean | null): boolean {
  return side === 'agency' && hasClient === false;
}

/**
 * The tiles: the same set on touch and laptop, Schedule last. A chat that
 * cannot schedule (Personal notes) leaves Schedule out. Draft and Plan are
 * disabled unless `draft` / `plan` is true (absent counts as unknown, so
 * disabled). Pure.
 */
export function trayTiles(
  layout: ChatLayout,
  opts: { schedule?: boolean; draft?: boolean; plan?: boolean } = {},
): TrayTile[] {
  void layout;
  const tiles: TrayTile[] = [
    { id: 'photos', label: 'Photos', Icon: IconImage },
    { id: 'file', label: 'File', Icon: IconFile },
    { id: 'assets', label: 'Assets', Icon: IconFolder },
    { id: 'brief', label: 'Brief', Icon: IconBriefs },
    { id: 'post', label: 'Post', Icon: IconPipeline },
    opts.draft === true
      ? { id: 'draft', label: 'Draft', Icon: IconDraft }
      : {
          id: 'draft',
          label: 'Draft',
          Icon: IconDraft,
          disabled: true,
          ariaLabel: DRAFT_UNAVAILABLE_LABEL,
        },
    opts.plan === true
      ? { id: 'plan', label: 'Plan', Icon: IconPlan }
      : {
          id: 'plan',
          label: 'Plan',
          Icon: IconPlan,
          disabled: true,
          // No Schedule means Personal notes, where a plan is never shared.
          ariaLabel: opts.schedule === false ? PLAN_NOTES_LABEL : PLAN_UNAVAILABLE_LABEL,
        },
  ];
  if (opts.schedule !== false) {
    tiles.push({ id: 'schedule', label: 'Schedule', Icon: IconCalendarClock });
  }
  return tiles;
}

export function ComposerTray(props: {
  layout: ChatLayout;
  onPick: (id: TrayTileId) => void;
  /** False: the chat cannot schedule, so no Schedule tile. Absent is true. */
  schedule?: boolean;
  /** True: the Draft tile is live. Absent or false: faded and disabled. */
  draft?: boolean;
  /** True: the Plan tile is live. Absent or false: faded and disabled. */
  plan?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Kept mounted through the exit; `shown` drives the transition.
  const [rendered, setRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = setTimeout(() => setRendered(false), TRAY_MOTION_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: Event): void {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tiles = trayTiles(props.layout, {
    schedule: props.schedule !== false,
    draft: props.draft === true,
    plan: props.plan === true,
  });
  return (
    <div ref={rootRef} className={cn('shrink-0', NO_TOUCH_SELECT)} onContextMenu={preventDefault}>
      <button
        ref={buttonRef}
        type="button"
        data-plus=""
        aria-label={open ? 'Close attachments' : 'Add attachment'}
        aria-expanded={open}
        aria-controls="composer-tray"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full border transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          open
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-border bg-panel text-fg-2 hover:text-fg',
        )}
      >
        <span
          aria-hidden="true"
          data-plus-icon=""
          className={cn(
            'flex transition-transform duration-[180ms] ease-out motion-reduce:transition-none',
            open && 'rotate-45',
          )}
        >
          <IconPlus size={22} />
        </span>
      </button>
      {rendered ? (
        <div
          id="composer-tray"
          role="group"
          aria-label="Attach"
          data-tray=""
          className={cn(
            'absolute inset-x-0 bottom-full z-20 border-t border-border bg-panel px-3 pb-2 pt-3 transition-[opacity,transform] duration-[180ms] ease-out motion-reduce:transition-none',
            shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          <TrayGrid
            tiles={tiles}
            onPick={(id) => {
              setOpen(false);
              props.onPick(id);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tray's tile grid, 4 columns (8 tiles: two rows of 4; 7 in notes). A
 * disabled tile is faded, carries the disabled attribute and aria-disabled,
 * says why in its name, and never calls onPick.
 */
export function TrayGrid(props: {
  tiles: readonly TrayTile[];
  onPick: (id: TrayTileId) => void;
}): ReactElement {
  const tiles = props.tiles;
  return (
    <div className="grid grid-cols-4 gap-2">
      {tiles.map((tile) => (
        <button
          key={tile.id}
          type="button"
          data-tray-tile={tile.id}
          disabled={tile.disabled === true}
          {...(tile.disabled === true ? { 'aria-disabled': true } : {})}
          {...(tile.ariaLabel !== undefined ? { 'aria-label': tile.ariaLabel } : {})}
          onClick={() => {
            if (tile.disabled === true) return;
            props.onPick(tile.id);
          }}
          className="flex min-h-[72px] min-w-[44px] flex-col items-center justify-center gap-1.5 rounded-lg text-fg-2 hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-panel-2 text-fg">
            <tile.Icon size={22} />
          </span>
          <span className="text-xs font-medium">{tile.label}</span>
        </button>
      ))}
    </div>
  );
}

function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault();
}
