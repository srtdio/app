// The nine moves (docs/motion.md). Each declares its axis. Values are final
// (Sorted Motion Prototype); do not invent new ones.
import { play, type MoveSpec, type Played } from './run';
import {
  CARD_RADIUS_PX,
  DIALOG_FROM_SCALE,
  DUR_BACK_MS,
  DUR_BASE_MS,
  DUR_FAST_MS,
  DUR_GROW_BACK_MS,
  DUR_GROW_MS,
  DUR_MENU_MS,
  DUR_PUSH_MS,
  DUR_SHEET_IN_MS,
  DUR_SHEET_OUT_MS,
  DUR_SLOW_MS,
  DUR_TOAST_MS,
  DUR_WIPE_MS,
  EASE,
  ITEM_RISE_PX,
  MENU_FROM_SCALE,
  PUSH_BEHIND_SHIFT,
  SETTLE_PX,
  SETTLE_STAGGER_MAX,
  SETTLE_STAGGER_MS,
} from './tokens';

// 1. push. Axis: X only.
export const PUSH: MoveSpec = { move: 'push', axis: ['x'], marked: true };
// 2. growFromCard. Axis: scale from the card's origin (with the FLIP translate).
export const GROW_FROM_CARD: MoveSpec = { move: 'growFromCard', axis: ['scale'], marked: true };
// 3. rise. Axis: Y (phone sheet); scale from centre (laptop dialog).
export const RISE: MoveSpec = { move: 'rise', axis: ['y'], marked: true };
export const DIALOG_GROW: MoveSpec = { move: 'rise', axis: ['scale'], marked: true };
// 4. growFromTrigger. Axis: scale from the trigger or cursor point.
export const GROW_FROM_TRIGGER: MoveSpec = { move: 'growFromTrigger', axis: ['scale'] };
// 5. press. Axis: scale (CSS: .mv-press in motion.css).
export const PRESS: MoveSpec = { move: 'press', axis: ['scale'] };
// 6. itemIn / itemOut. Axis: Y (in), clip upward (out).
export const ITEM_IN: MoveSpec = { move: 'itemIn', axis: ['y'] };
export const ITEM_OUT: MoveSpec = { move: 'itemOut', axis: ['clip'] };
// 7. glide. Axis: Y for lists and feeds; X+Y for grids. (GlideList, layout via motion.)
export const GLIDE_LIST: MoveSpec = { move: 'glide', axis: ['y'] };
export const GLIDE_GRID: MoveSpec = { move: 'glide', axis: ['x', 'y'] };
// Search focus: the toolbar's other controls glide aside on X only.
export const GLIDE_ASIDE: MoveSpec = { move: 'glide', axis: ['x'] };
// 8. edgeStrip. Axis: Y.
export const EDGE_STRIP: MoveSpec = { move: 'edgeStrip', axis: ['y'] };
// 9. sweepBoxes. Axis: fill (background-position sweep in motion.css) + Y settle.
export const SWEEP_BOXES: MoveSpec = { move: 'sweepBoxes', axis: ['fill', 'y'] };

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

// ---------- 1. push ----------

// The screen behind a push holds its shifted pose until the push back.
const heldBehind = new WeakMap<Element, Played>();

function releaseBehind(behind: Element): void {
  heldBehind.get(behind)?.cancel();
  heldBehind.delete(behind);
}

/** A deeper screen enters from the right; the screen behind shifts left 25%. */
export function pushIn(incoming: Element | null, behind?: Element | null): Played {
  const width = (incoming as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  if (behind) {
    releaseBehind(behind);
    const held = play(
      behind,
      PUSH,
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${px(-width * PUSH_BEHIND_SHIFT)})` },
      ],
      {
        duration: DUR_PUSH_MS,
        easing: EASE.ios,
        fill: 'forwards',
      },
    );
    if (!held.instant) heldBehind.set(behind, held);
  }
  return play(incoming, PUSH, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], {
    duration: DUR_PUSH_MS,
    easing: EASE.ios,
  });
}

/** Back: the top screen leaves to the right from `fromX` px; the one behind returns. */
export function pushBack(outgoing: Element | null, behind?: Element | null, fromX = 0): Played {
  const width = (outgoing as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  if (behind) {
    releaseBehind(behind);
    const start = -width * PUSH_BEHIND_SHIFT * (1 - (width > 0 ? fromX / width : 0));
    play(
      behind,
      PUSH,
      [{ transform: `translateX(${px(start)})` }, { transform: 'translateX(0)' }],
      {
        duration: DUR_BACK_MS,
        easing: EASE.ios,
      },
    );
  }
  return play(
    outgoing,
    PUSH,
    [{ transform: `translateX(${px(fromX)})` }, { transform: 'translateX(100%)' }],
    {
      duration: DUR_BACK_MS,
      easing: EASE.ios,
      fill: 'forwards',
    },
  );
}

/** Spring back after a short edge drag: from `fromX` px to rest. */
export function pushSettle(el: Element | null, fromX: number): Played {
  return play(
    el,
    PUSH,
    [{ transform: `translateX(${px(fromX)})` }, { transform: 'translateX(0)' }],
    {
      duration: DUR_BACK_MS,
      easing: EASE.ios,
    },
  );
}

// ---------- 2. growFromCard ----------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function flip(from: Box, to: Box): string {
  const sx = to.width > 0 ? from.width / to.width : 1;
  const sy = to.height > 0 ? from.height / to.height : 1;
  return `translate(${px(from.left - to.left)}, ${px(from.top - to.top)}) scale(${sx}, ${sy})`;
}

/** The page grows out of the tapped card's rect; corners 12 to 0. 300 ms. */
export function growFromCard(page: Element | null, card: Box): Played {
  if (!page) return play(null, GROW_FROM_CARD, [], { duration: 0, easing: EASE.ios });
  const to = page.getBoundingClientRect();
  return play(
    page,
    GROW_FROM_CARD,
    [
      { transform: flip(card, to), borderRadius: px(CARD_RADIUS_PX) },
      { transform: 'none', borderRadius: '0px' },
    ],
    { duration: DUR_GROW_MS, easing: EASE.ios, origin: '0 0' },
  );
}

/** Back: the card grows back from the page's rect into its own place. 260 ms. */
export function growBackIntoCard(card: Element | null, page: Box): Played {
  if (!card) return play(null, GROW_FROM_CARD, [], { duration: 0, easing: EASE.ios });
  const to = card.getBoundingClientRect();
  return play(
    card,
    GROW_FROM_CARD,
    [
      { transform: flip(page, to), borderRadius: '0px' },
      { transform: 'none', borderRadius: px(CARD_RADIUS_PX) },
    ],
    { duration: DUR_GROW_BACK_MS, easing: EASE.ios, origin: '0 0' },
  );
}

// ---------- 3. rise ----------

/** Sheet in: translateY 100% (or `fromY` px) to 0, 320 ms. */
export function riseIn(panel: Element | null, fromY?: number): Played {
  return play(
    panel,
    RISE,
    [
      { transform: fromY === undefined ? 'translateY(100%)' : `translateY(${px(fromY)})` },
      { transform: 'translateY(0)' },
    ],
    { duration: DUR_SHEET_IN_MS, easing: EASE.ios },
  );
}

/** Sheet out: from `fromY` px (a drag) to 100%, 240 ms, held until unmount. */
export function riseOut(panel: Element | null, fromY = 0): Played {
  return play(
    panel,
    RISE,
    [{ transform: `translateY(${px(fromY)})` }, { transform: 'translateY(100%)' }],
    {
      duration: DUR_SHEET_OUT_MS,
      easing: EASE.ios,
      fill: 'forwards',
    },
  );
}

/** Laptop centre dialog: grows 95% to 100%, 200 ms, no fade. */
export function dialogIn(panel: Element | null): Played {
  return play(
    panel,
    DIALOG_GROW,
    [{ transform: `scale(${DIALOG_FROM_SCALE})` }, { transform: 'scale(1)' }],
    {
      duration: DUR_SLOW_MS,
      easing: EASE.ios,
    },
  );
}

/** Laptop centre dialog out: back to 95%, held until unmount. */
export function dialogOut(panel: Element | null): Played {
  return play(
    panel,
    DIALOG_GROW,
    [{ transform: 'scale(1)' }, { transform: `scale(${DIALOG_FROM_SCALE})` }],
    {
      duration: DUR_BASE_MS,
      easing: EASE.exit,
      fill: 'forwards',
    },
  );
}

// ---------- 4. growFromTrigger ----------

/**
 * Menu grows .90 to 1 from `origin` (CSS transform-origin, e.g. "top right" or
 * "12px 40px"). 160 ms ease-enter: menus and popovers land without overshoot
 * (ease-pop is kept for pop() only).
 */
export function growFromTrigger(menu: Element | null, origin = 'top left'): Played {
  return play(
    menu,
    GROW_FROM_TRIGGER,
    [{ transform: `scale(${MENU_FROM_SCALE})` }, { transform: 'scale(1)' }],
    {
      duration: DUR_MENU_MS,
      easing: EASE.enter,
      origin,
    },
  );
}

/** Menu shrinks back toward its trigger, held until unmount. */
export function shrinkToTrigger(menu: Element | null, origin = 'top left'): Played {
  return play(
    menu,
    GROW_FROM_TRIGGER,
    [{ transform: 'scale(1)' }, { transform: `scale(${MENU_FROM_SCALE})` }],
    {
      duration: DUR_FAST_MS,
      easing: EASE.exit,
      fill: 'forwards',
      origin,
    },
  );
}

/** Origin for a menu placed at `menuBox` grown from `point` (trigger centre or cursor). */
export function originFrom(point: { x: number; y: number }, menuBox: Box): string {
  return `${px(point.x - menuBox.left)} ${px(point.y - menuBox.top)}`;
}

// ---------- 6. itemIn / itemOut ----------

/** A new row rises 8 px into place. 180 ms ease-enter (160-200 band). */
export function itemIn(el: Element | null, delay = 0): Played {
  return play(
    el,
    ITEM_IN,
    [{ transform: `translateY(${ITEM_RISE_PX}px)` }, { transform: 'translateY(0)' }],
    {
      duration: 180,
      easing: EASE.enter,
      delay,
    },
  );
}

/** A row closes upward (clip from the bottom), 200 ms, held until unmount. */
export function itemOut(el: Element | null): Played {
  return play(el, ITEM_OUT, [{ clipPath: 'inset(0 0 0% 0)' }, { clipPath: 'inset(0 0 100% 0)' }], {
    duration: DUR_SLOW_MS,
    easing: EASE.exit,
    fill: 'forwards',
  });
}

// ---------- 7. glide (search focus) ----------

/** Where the toolbar controls rest while the phone search is the centre (past the row's 16 px inset). */
export const GLIDE_ASIDE_X = 'translateX(calc(100% + 1rem))';

/**
 * Phone search focus: the sort and New controls glide out to the right
 * (`out`) or back into the row. X only, --dur-base, ease-move. The element is
 * already at its end pose by class (translate-x-[calc(100%+1rem)] or none).
 */
export function glideAside(el: Element | null, out: boolean): Played {
  const from = out ? 'translateX(0)' : GLIDE_ASIDE_X;
  const to = out ? GLIDE_ASIDE_X : 'translateX(0)';
  return play(el, GLIDE_ASIDE, [{ transform: from }, { transform: to }], {
    duration: DUR_BASE_MS,
    easing: EASE.move,
  });
}

// ---------- 8. edgeStrip ----------

export type StripEdge = 'top' | 'bottom' | 'above-composer';

function stripFrom(edge: StripEdge, distance?: number): string {
  if (edge === 'top') return 'translateY(-100%)';
  if (edge === 'bottom') return 'translateY(100%)';
  // Strips above the composer slide 8-48 px on Y.
  const d = Math.min(48, Math.max(8, distance ?? 24));
  return `translateY(${d}px)`;
}

/** A strip arrives from its edge. Toasts 320 ms; strips above the composer 200 ms. */
export function stripIn(el: Element | null, edge: StripEdge, distance?: number): Played {
  return play(
    el,
    EDGE_STRIP,
    [{ transform: stripFrom(edge, distance) }, { transform: 'translateY(0)' }],
    {
      duration: edge === 'above-composer' ? DUR_SLOW_MS : DUR_TOAST_MS,
      easing: edge === 'above-composer' ? EASE.enter : EASE.ios,
    },
  );
}

/** A strip leaves the same way it came, never a fade. Held until unmount. */
export function stripOut(
  el: Element | null,
  edge: StripEdge,
  distance?: number,
  fromY = 0,
): Played {
  return play(
    el,
    EDGE_STRIP,
    [{ transform: `translateY(${px(fromY)})` }, { transform: stripFrom(edge, distance) }],
    {
      duration: edge === 'above-composer' ? DUR_BASE_MS : DUR_SHEET_OUT_MS,
      easing: EASE.exit,
      fill: 'forwards',
    },
  );
}

// ---------- 9. sweepBoxes (settle on landing) ----------

/** Real content lands: each item settles 6 px, 200 ms, 40 ms stagger (max 5). */
export function settle(items: ArrayLike<Element>): void {
  const count = Math.min(items.length, SETTLE_STAGGER_MAX);
  for (let i = 0; i < count; i += 1) {
    play(
      items[i],
      SWEEP_BOXES,
      [{ transform: `translateY(${SETTLE_PX}px)` }, { transform: 'translateY(0)' }],
      {
        duration: DUR_SLOW_MS,
        easing: EASE.enter,
        delay: i * SETTLE_STAGGER_MS,
      },
    );
  }
}

// ---------- Small touches (same tokens) ----------

export const TOUCH_TICK: MoveSpec = { move: 'touch', axis: ['fill'] };
export const TOUCH_POP: MoveSpec = { move: 'touch', axis: ['scale'] };
export const TOUCH_ROLL: MoveSpec = { move: 'touch', axis: ['y'] };
export const TOUCH_SHAKE: MoveSpec = { move: 'touch', axis: ['x'] };
export const TOUCH_SWING: MoveSpec = { move: 'touch', axis: ['rotate'] };
export const TOUCH_WIPE: MoveSpec = { move: 'touch', axis: ['clip'] };
export const TOUCH_SLIDE: MoveSpec = { move: 'touch', axis: ['x'] };

/** The tick or cross draws (stroke-dashoffset), 220 ms. The path needs pathLength="1". */
export function drawTick(path: Element | null): Played {
  return play(path, TOUCH_TICK, [{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], {
    duration: 220,
    easing: EASE.enter,
  });
}

/** Unread pill, star, mark, OK chip: pop from .9 with ease-pop. */
export function pop(el: Element | null): Played {
  return play(el, TOUCH_POP, [{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }], {
    duration: DUR_SLOW_MS,
    easing: EASE.pop,
  });
}

/** A count digit rolls one step on Y, 160 ms. direction 1 = up (count grew). */
export function rollDigit(el: Element | null, direction: 1 | -1 = 1): Played {
  return play(
    el,
    TOUCH_ROLL,
    [{ transform: `translateY(${direction * 60}%)` }, { transform: 'translateY(0)' }],
    {
      duration: DUR_BASE_MS,
      easing: EASE.enter,
    },
  );
}

/** Wrong sign-in code: the boxes shake on X, 320 ms, plus or minus 10 px. */
export function shake(el: Element | null): Played {
  return play(
    el,
    TOUCH_SHAKE,
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-10px)' },
      { transform: 'translateX(10px)' },
      { transform: 'translateX(-10px)' },
      { transform: 'translateX(10px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 320, easing: 'linear' },
  );
}

/** Reminder due: the bell swings 3 times over 700 ms (rotation). */
export function bellSwing(el: Element | null): Played {
  const frames: Keyframe[] = [{ transform: 'rotate(0deg)' }];
  for (let i = 0; i < 3; i += 1)
    frames.push({ transform: 'rotate(14deg)' }, { transform: 'rotate(-14deg)' });
  frames.push({ transform: 'rotate(0deg)' });
  return play(el, TOUCH_SWING, frames, { duration: 700, easing: 'ease-in-out', origin: '50% 0' });
}

/** Landing highlight: the tint wipes away left to right over 1200 ms. Held (gone) at the end. */
export function wipeAway(el: Element | null): Played {
  return play(
    el,
    TOUCH_WIPE,
    [{ clipPath: 'inset(0 0 0 0%)' }, { clipPath: 'inset(0 0 0 100%)' }],
    {
      duration: DUR_WIPE_MS,
      easing: EASE.move,
      fill: 'forwards',
    },
  );
}

/** Plan week/month change: the grid slides on X in the swipe or arrow direction, 240 ms. */
export function slideX(el: Element | null, direction: 1 | -1): Played {
  return play(
    el,
    TOUCH_SLIDE,
    [{ transform: `translateX(${direction * 24}%)` }, { transform: 'translateX(0)' }],
    {
      duration: DUR_BACK_MS,
      easing: EASE.ios,
    },
  );
}

/** Upload finished: the tile settles with ease-pop (ring scales to 0 in CSS). */
export function uploadSettle(tile: Element | null): Played {
  return pop(tile);
}

/** Tour cards and onboarding steps slide on X; Back reverses. */
export function stepX(el: Element | null, direction: 1 | -1): Played {
  return play(
    el,
    PUSH,
    [{ transform: `translateX(${direction * 32}px)` }, { transform: 'translateX(0)' }],
    {
      duration: DUR_PUSH_MS,
      easing: EASE.ios,
    },
  );
}

/** Command palette: drops 8 px from the top. */
export function dropIn(el: Element | null): Played {
  return play(
    el,
    EDGE_STRIP,
    [{ transform: `translateY(-${ITEM_RISE_PX}px)` }, { transform: 'translateY(0)' }],
    {
      duration: DUR_MENU_MS,
      easing: EASE.enter,
    },
  );
}

// Selection, count and nav touches (5 Nov 2026, Purist-inspired, approved by Shubham).
/** Count badge: the pill widens or narrows with its digits. */
export const TOUCH_WIDEN: MoveSpec = { move: 'touch', axis: ['fill'] };
/** Nav icon nudge: a small lift and tilt when its unread count rises. */
export const TOUCH_NUDGE_ICON: MoveSpec = { move: 'touch', axis: ['y', 'rotate'] };

/** Count badge: the pill eases from its old width to its new one, 200 ms, ease-enter. */
export function widenBadge(el: Element | null, fromWidth: number, toWidth: number): Played {
  return play(el, TOUCH_WIDEN, [{ width: `${fromWidth}px` }, { width: `${toWidth}px` }], {
    duration: DUR_SLOW_MS,
    easing: EASE.enter,
  });
}

/** Nav icon nudge: lift 4 px and tilt -8deg, swing to +4deg, settle; 320 ms, ease-pop. */
export function nudgeIcon(el: Element | null): Played {
  return play(
    el,
    TOUCH_NUDGE_ICON,
    [
      { translate: '0px 0px', rotate: '0deg' },
      { translate: '0px -4px', rotate: '-8deg', offset: 0.35 },
      { translate: '0px 0px', rotate: '4deg', offset: 0.7 },
      { translate: '0px 0px', rotate: '0deg' },
    ],
    { duration: DUR_SHEET_IN_MS, easing: EASE.pop },
  );
}

// ---------- unfold (Activity "Show more" / "Show less", 10 Nov 2026) ----------

/**
 * A row's height eases from what it was to what it is now (axis clip: the
 * height edge moves, never a fade). The rows under it move with it, since
 * they follow its layout every frame. Instant under Reduce Motion (play).
 */
export const UNFOLD: MoveSpec = { move: 'unfold', axis: ['clip'] };

/**
 * Unfold or fold `el` from `fromPx` to its current height: DUR_GROW_MS,
 * ease-unfold (gentle in and out), overflow clipped while it runs. Nothing
 * runs when the height did not change. 12 Nov 2026: DUR_SLOW_MS + ease-ios
 * moved a 160px unfold 56px in one frame, which read as a jerk; ease-move
 * still peaked at 30px. ease-unfold over DUR_GROW_MS keeps each frame small.
 */
export function unfold(el: HTMLElement | null, fromPx: number): Played {
  if (el === null) return play(null, UNFOLD, [], { duration: 0, easing: EASE.ios });
  const toPx = el.getBoundingClientRect().height;
  if (Math.abs(toPx - fromPx) < 1) return play(null, UNFOLD, [], { duration: 0, easing: EASE.ios });
  const overflow = el.style.overflow;
  el.style.overflow = 'hidden';
  const played = play(el, UNFOLD, [{ height: `${fromPx}px` }, { height: `${toPx}px` }], {
    duration: DUR_GROW_MS,
    easing: EASE.unfold,
  });
  void played.done.then(() => {
    el.style.overflow = overflow;
  });
  return played;
}
