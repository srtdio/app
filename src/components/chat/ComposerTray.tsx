// The composer's attach button and its tray. The button is a 44x44 circle on
// the panel showing a plus (the tray opener); while the tray is open it turns
// accent and the plus turns 45deg into an X (mv-turn). The tray sits above the
// composer: a 4-column grid of tiles (Photos, File, Assets, Brief, Post,
// Draft, Plan, then Tasks in a chat with a task list, on touch and laptop alike) that slides up on Y from
// the composer and back down (edgeStrip above the composer, never a fade, no
// X and no scale). A tap outside, Escape, or picking a tile closes it.
// Photos / File run the composer's attach paths (the Photos picker still offers
// Take Photo on phones); Assets opens the library picker; Brief, Post and Draft
// open the share picker in that mode; Plan opens the New plan screen; Tasks
// opens the chat's Tasks sheet (its accent dot while someone else changed the
// list since this device last looked). Draft is live only for an agency-side viewer in a
// chat with no client, Plan only for an agency-side viewer: otherwise (or while
// either is unknown) they render faded and disabled from the first frame. Tokens only, so light and dark stay at parity.
//
// Inside ui/WritingBox (compact, every + there is: chat, comments, replies,
// checkpoint slots) the tray is the top of that same box: drawn into the box's
// tray slot (ui/writing-tray.ts), inside its one outline, on its bg-panel-2
// fill, no shadow, in flow (the thread above lifts; nothing is covered), one
// column per tile and 20 icons (ICON_SIZE.control). The box holds open/closed,
// so the + moving from the pill into the card keeps its tray.

import { mark } from '@/lib/perf-marks';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentType, ReactElement } from 'react';
import { WritingTrayContext, trayColumnsClass } from '@/components/ui/writing-tray';
import {
  ICON_SIZE,
  IconAssets,
  IconBriefs,
  IconDraft,
  IconFile,
  IconPhoto,
  IconPipeline,
  IconPlan,
  IconPlus,
  IconTaskSquare,
} from '@/components/ui/icons';
import { isClient } from '@/components/pages/pcs/roles';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { NO_TOUCH_SELECT, type ChatLayout } from '@/components/chat/chat-type';
import { INDUCTION_KEYS } from '@/lib/induction';
import { MOVE_CLASS, stripIn, stripOut, usePresence } from '@/lib/motion';

/** The tray and the plus icon move for this long. */
/** How far the tray slides on Y from the composer (px, the 8-48 band). */
const TRAY_SLIDE_PX = 8;

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
  | 'tasks';

/** One tray tile. A disabled tile renders faded, has no tap action and says why. */
interface TrayTile {
  id: TrayTileId;
  label: string;
  Icon: TileIcon;
  disabled?: true;
  /** The accessible name when it differs from the label (a disabled Draft says why). */
  ariaLabel?: string;
  /** The accent dot on the icon (Tasks: changed since this device last looked). */
  dot?: true;
}

/** The Tasks tile's name: "Tasks", or "Tasks, new" while the dot shows (never colour alone). Pure. */
export function tasksTileLabel(unseen: boolean): string {
  return unseen ? 'Tasks, new' : 'Tasks';
}

/** The disabled Draft tile's accessible name. */
export const DRAFT_UNAVAILABLE_LABEL = 'Draft, not available in chats with approvers';

/** The disabled Plan tile's accessible name. */
export const PLAN_UNAVAILABLE_LABEL = 'Plan, only creators can share a plan';

/** The Plan tile's accessible name in Personal notes (a plan is shared into a chat). */
const PLAN_NOTES_LABEL = 'Plan, not available in Personal notes';

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
 * The tiles: the same set on touch and laptop. Draft and Plan are disabled
 * unless `draft` / `plan` is true (absent counts as unknown, so disabled);
 * in Personal notes (`notes`) the disabled Plan says a plan is never shared
 * there. Tasks is last, only where the chat has a task list (`tasks`), its
 * dot while `tasks.unseen`. Pure.
 */
export function trayTiles(
  layout: ChatLayout,
  opts: {
    notes?: boolean;
    draft?: boolean;
    plan?: boolean;
    tasks?: { unseen: boolean } | undefined;
  } = {},
): TrayTile[] {
  void layout;
  const tiles: TrayTile[] = [
    { id: 'photos', label: 'Photos', Icon: IconPhoto },
    { id: 'file', label: 'File', Icon: IconFile },
    { id: 'assets', label: 'Assets', Icon: IconAssets },
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
          // Personal notes, where a plan is never shared.
          ariaLabel: opts.notes === true ? PLAN_NOTES_LABEL : PLAN_UNAVAILABLE_LABEL,
        },
  ];
  if (opts.tasks !== undefined) {
    tiles.push({
      id: 'tasks',
      label: 'Tasks',
      Icon: IconTaskSquare,
      ...(opts.tasks.unseen ? { dot: true as const, ariaLabel: tasksTileLabel(true) } : {}),
    });
  }
  return tiles;
}

export function ComposerTray(props: {
  layout: ChatLayout;
  onPick: (id: TrayTileId) => void;
  /** Personal notes: the disabled Plan says why. */
  notes?: boolean;
  /** The chat's task list: the Tasks tile (its dot while unseen). Absent: no tile. */
  tasks?: { unseen: boolean } | undefined;
  /** True: the Draft tile is live. Absent or false: faded and disabled. */
  draft?: boolean;
  /** True: the Plan tile is live. Absent or false: faded and disabled. */
  plan?: boolean;
  /**
   * Told whether the tray is on screen (open or sliding out), so the composer
   * bar under it takes lit-dock-joined and no seam shows between the two.
   */
  onShownChange?: (shown: boolean) => void;
  /**
   * A composer outside chat (the comment composers): only these tiles (kept in
   * the tray's order), its own tray id (several can be on one screen) and no
   * chat tour keys. Absent: the chat tray, unchanged.
   */
  only?: { tiles: readonly TrayTileId[]; trayId: string };
  /**
   * Inside ui/WritingBox: the + is a 36 grey circle on a 44 tall hit (the
   * composer-row 36 exception); ink while open, the plus turned into the X.
   */
  compact?: boolean;
}): ReactElement {
  // In a writing box the box holds open / closed (the + can move between its
  // pill and its card); elsewhere the tray keeps its own.
  const box = useContext(WritingTrayContext);
  const boxed = box !== null && props.compact === true;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = boxed ? box.open : ownOpen;
  const setOpen = boxed ? box.setOpen : setOwnOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Kept mounted through the exit: painted at rest, the slide laid over it.
  const tray = usePresence<HTMLDivElement>(open, {
    enter: (el) => stripIn(el, 'above-composer', TRAY_SLIDE_PX),
    exit: (el) => stripOut(el, 'above-composer', TRAY_SLIDE_PX),
  });

  const onShownChange = props.onShownChange;
  useEffect(() => {
    if (!tray.rendered) return;
    onShownChange?.(true);
    // Also runs on unmount, so the bar never keeps the joined light alone.
    return () => onShownChange?.(false);
  }, [tray.rendered, onShownChange]);

  useEffect(() => {
    if (open) mark('chat:tray:open');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: Event): void {
      const root = rootRef.current;
      const target = event.target as Node;
      // The boxed tray is drawn in the box's slot, outside the + itself.
      const inTray = tray.ref.current?.contains(target) === true;
      if (root !== null && !root.contains(target) && !inTray) setOpen(false);
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
    // tray.ref is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen]);

  const allTiles = trayTiles(props.layout, {
    notes: props.notes === true,
    draft: props.draft === true,
    plan: props.plan === true,
    tasks: props.tasks,
  });
  const only = props.only;
  const tiles =
    only === undefined ? allTiles : allTiles.filter((tile) => only.tiles.includes(tile.id));
  const trayId = only === undefined ? 'composer-tray' : only.trayId;
  return (
    <div ref={rootRef} className={cn('shrink-0', NO_TOUCH_SELECT)} onContextMenu={preventDefault}>
      <Button
        variant={props.compact === true ? 'ghost' : open ? 'primary' : 'secondary'}
        shape="round"
        buttonRef={buttonRef}
        type="button"
        data-plus=""
        data-induction={only === undefined ? INDUCTION_KEYS.chatPlus : undefined}
        aria-label={open ? 'Close attachments' : 'Add attachment'}
        aria-expanded={open}
        aria-controls={trayId}
        onClick={() => setOpen(!open)}
        className={
          props.compact === true ? 'w-9 min-w-9 items-stretch py-1 hover:bg-transparent' : undefined
        }
        // Round secondary, primary while the tray is open; buttonRef returns
        // focus on Escape.
      >
        {/* The plus turns 45deg into the X while the tray is open. */}
        <span
          aria-hidden="true"
          data-plus-icon=""
          className={cn(
            'flex',
            props.compact === true && 'w-full items-center justify-center rounded-full',
            props.compact === true && (open ? 'bg-accent text-accent-fg' : 'bg-panel-3 text-fg-2'),
            MOVE_CLASS.turn,
            open && 'rotate-45',
          )}
        >
          <IconPlus size={ICON_SIZE.control} />
        </span>
      </Button>
      {tray.rendered && boxed && box.slot !== null
        ? createPortal(
            // The top of the writing box: its fill, its outline, a hairline
            // under the tiles; no shadow.
            <div
              ref={tray.ref}
              id={trayId}
              role="group"
              aria-label="Attach"
              data-tray=""
              data-tray-boxed=""
              data-induction={only === undefined ? INDUCTION_KEYS.chatAttachTray : undefined}
              className="border-b pb-2 pt-2"
            >
              <TrayGrid
                boxed
                tiles={tiles}
                onPick={(id) => {
                  setOpen(false);
                  props.onPick(id);
                }}
              />
            </div>,
            box.slot,
          )
        : null}
      {tray.rendered && !boxed ? (
        <div
          ref={tray.ref}
          id={trayId}
          role="group"
          aria-label="Attach"
          data-tray=""
          data-induction={only === undefined ? INDUCTION_KEYS.chatAttachTray : undefined}
          className="absolute inset-x-0 bottom-full z-sticky border-t bg-panel lit-dock px-3 pb-2 pt-3"
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
 * The tray's tile grid, 4 columns (8 tiles: two rows of 4; 7 in notes); in a
 * writing box (`boxed`) one row, a column per tile, 20 icons on a flat
 * hairline circle. A disabled tile takes fg-3 ink (never a fade), carries the
 * disabled attribute and aria-disabled, says why in its name, and never calls
 * onPick.
 */
export function TrayGrid(props: {
  tiles: readonly TrayTile[];
  onPick: (id: TrayTileId) => void;
  boxed?: boolean;
}): ReactElement {
  const tiles = props.tiles;
  const boxed = props.boxed === true;
  return (
    <div
      data-tray-cols={boxed ? tiles.length : undefined}
      className={cn('grid gap-2', boxed ? trayColumnsClass(tiles.length) : 'grid-cols-4')}
    >
      {tiles.map((tile) => (
        <PressableRow
          key={tile.id}
          align="center"
          type="button"
          data-tray-tile={tile.id}
          {...(tile.id === 'tasks' ? { 'data-induction': INDUCTION_KEYS.chatTasks } : {})}
          {...(tile.dot === true ? { 'data-task-unseen': '' } : {})}
          disabled={tile.disabled === true}
          {...(tile.disabled === true ? { 'aria-disabled': true } : {})}
          {...(tile.ariaLabel !== undefined ? { 'aria-label': tile.ariaLabel } : {})}
          onClick={() => {
            if (tile.disabled === true) return;
            props.onPick(tile.id);
          }}
          className="flex h-18 min-w-11 flex-col items-center justify-center gap-2 text-fg-2 hover:text-fg"
        >
          <span
            className={cn(
              'relative flex h-11 w-11 items-center justify-center rounded-full text-fg',
              boxed ? 'border bg-panel' : 'bg-panel-2 lit-btn-secondary',
            )}
          >
            <tile.Icon size={boxed ? ICON_SIZE.control : ICON_SIZE.tray} />
            {tile.dot === true ? (
              <span
                aria-hidden="true"
                data-task-dot=""
                className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-panel"
              />
            ) : null}
          </span>
          <span className="text-sm font-medium">{tile.label}</span>
        </PressableRow>
      ))}
    </div>
  );
}

function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault();
}
