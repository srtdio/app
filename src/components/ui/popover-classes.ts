import { growFromTrigger, originFrom, shrinkToTrigger, type PresenceMoves } from '@/lib/motion';

/**
 * The shared floating-menu container: the chat row menu, the message actions
 * panel, the attachment menu, the plan day menu and the person card. It always
 * renders at rest; motion (docs/motion.md, growFromTrigger) is laid over it by
 * the caller with growFromTrigger / shrinkToTrigger. Never a fade.
 */
const POPOVER_PANEL = 'lit-overlay rounded-xl border bg-panel p-1.5';

/**
 * The panel classes. The argument is kept for callers that still pass their
 * open phase; the panel looks the same in every phase (no opacity or scale
 * classes: the move is a Web Animation, not a class swap).
 */
export const popoverClass: (shown?: boolean) => string = () => POPOVER_PANEL;

/**
 * The transform-origin a menu at `menu` grows from: `point` (trigger centre or
 * right-click cursor, viewport px), else the centre of the menu's parent (the
 * wrapper that holds its trigger), else its top corner on `align`.
 */
export function menuOrigin(
  menu: Element,
  point: { x: number; y: number } | null | undefined,
  align: 'left' | 'right' = 'left',
): string {
  const box = menu.getBoundingClientRect();
  let at = point ?? null;
  if (at === null) {
    const wrap = menu.parentElement?.getBoundingClientRect();
    if (wrap !== undefined && (wrap.width > 0 || wrap.height > 0)) {
      at = { x: wrap.left + wrap.width / 2, y: wrap.top + wrap.height / 2 };
    }
  }
  if (at === null) return align === 'right' ? 'top right' : 'top left';
  return originFrom(at, box);
}

type Point = { x: number; y: number };

// The origin each open menu grew from, so its shrink goes back to the same point.
const grownFrom = new WeakMap<Element, string>();

/**
 * usePresence moves for a popover menu (docs/motion.md, growFromTrigger):
 * grows .90 to 1 from `point()` (trigger centre or right-click cursor; default
 * the wrapper's centre) on open, shrinks back to the same point on close.
 */
export function menuMoves<T extends HTMLElement>(
  point?: () => Point | null | undefined,
  align: 'left' | 'right' = 'left',
): PresenceMoves<T> {
  return {
    enter: (el) => {
      const origin = menuOrigin(el, point?.() ?? null, align);
      grownFrom.set(el, origin);
      return growFromTrigger(el, origin);
    },
    exit: (el) => shrinkToTrigger(el, grownFrom.get(el) ?? menuOrigin(el, point?.() ?? null, align)),
  };
}

/** Centre of an element's box in viewport px (a trigger), or null. */
export function centreOf(el: Element | null | undefined): { x: number; y: number } | null {
  if (el === null || el === undefined) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
