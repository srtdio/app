// Motion tokens in milliseconds and curve strings. These mirror the --dur-* and
// --ease-* tokens in src/index.css so JS moves (Web Animations, motion) stay in
// lockstep with the CSS ones. src/lib/motion.test.ts reads the CSS from disk and
// fails if either side drifts. No runtime CSS reads here.
export const DUR_FAST_MS = 120;
export const DUR_BASE_MS = 160;
export const DUR_SLOW_MS = 200;
export const DUR_PUSH_MS = 280;
export const DUR_BACK_MS = 240;
export const DUR_GROW_MS = 300;
export const DUR_GROW_BACK_MS = 260;
export const DUR_SHEET_IN_MS = 320;
export const DUR_SHEET_OUT_MS = 240;
export const DUR_MENU_MS = 160;
export const DUR_TOAST_MS = 320;
export const DUR_WIPE_MS = 1200;
export const DUR_SWEEP_MS = 1100;

/** Curves as CSS strings (the same values as the --ease-* tokens). */
export const EASE = {
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.7, 0, 0.84, 0)',
  ios: 'cubic-bezier(0.32, 0.72, 0, 1)',
  move: 'cubic-bezier(0.77, 0, 0.175, 1)',
  pop: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** A height growing in place (Activity Show more / Show less). */
  unfold: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export type EaseName = keyof typeof EASE;

/** Every duration token paired with its CSS name; motion.test.ts walks this. */
export const DURATION_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ['dur-fast', DUR_FAST_MS],
  ['dur-base', DUR_BASE_MS],
  ['dur-slow', DUR_SLOW_MS],
  ['dur-push', DUR_PUSH_MS],
  ['dur-back', DUR_BACK_MS],
  ['dur-grow', DUR_GROW_MS],
  ['dur-grow-back', DUR_GROW_BACK_MS],
  ['dur-sheet-in', DUR_SHEET_IN_MS],
  ['dur-sheet-out', DUR_SHEET_OUT_MS],
  ['dur-menu', DUR_MENU_MS],
  ['dur-toast', DUR_TOAST_MS],
  ['dur-wipe', DUR_WIPE_MS],
  ['dur-sweep', DUR_SWEEP_MS],
];

// Gesture thresholds (prototype values, final).
/** Edge back starts only from a drag that begins within this many px of the left edge. */
export const EDGE_BACK_ZONE_PX = 28;
/** Edge back closes past this distance. */
export const EDGE_BACK_CLOSE_PX = 130;
/** Sheet drag-down closes past this distance. */
export const SHEET_CLOSE_PX = 140;
/** A flick faster than this (px per ms) closes a push or a sheet. */
export const FLICK_PX_PER_MS = 0.5;
/** Swipe up this far dismisses the Activity toast. */
export const TOAST_DISMISS_PX = 30;
/** The screen behind a push shifts left by this fraction of its width. */
export const PUSH_BEHIND_SHIFT = 0.25;
/** Pressed controls sink to this scale. */
export const PRESS_SCALE = 0.97;
/** Menus grow from this scale at their trigger. */
export const MENU_FROM_SCALE = 0.9;
/** Laptop centre dialogs grow from this scale. */
export const DIALOG_FROM_SCALE = 0.95;
/** itemIn rises this far on Y. */
export const ITEM_RISE_PX = 8;
/** Landed content settles this far on Y. */
export const SETTLE_PX = 6;
/** Stagger between settling items, and the most items that stagger. */
export const SETTLE_STAGGER_MS = 40;
export const SETTLE_STAGGER_MAX = 5;
/** Card corners go from this radius to 0 as a card grows into a page. */
export const CARD_RADIUS_PX = 12;
