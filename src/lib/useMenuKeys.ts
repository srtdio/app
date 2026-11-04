// The one keyboard contract for popover menus (AvatarMenu, SortMenu, the
// Pipeline sort control, ActionMenu and every MenuPopover, the schedule
// menu): on open, focus moves to the first item (or the checked one in a
// radio menu); Arrow Down / Up move between items (wrapping), Home / End jump
// to the ends. Escape and focus return to the trigger stay with
// useDismissLayer (modal-focus.ts), which every one of these already calls;
// call useMenuKeys after it so the trigger is remembered before focus moves.

import { useEffect, type KeyboardEvent, type RefObject } from 'react';
import { nextMenuIndex } from '@/lib/chat/menu-keys';

const ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
]
  .map((role) => `${role}:not([disabled]):not([aria-disabled="true"])`)
  .join(', ');

/** Every reachable item in a menu panel, in DOM order. */
export function menuItemsIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

/** Where focus lands on open: the checked radio item, else the first item. Pure over the DOM. */
export function menuInitialItem(panel: HTMLElement): HTMLElement | null {
  const items = menuItemsIn(panel);
  return items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0] ?? null;
}

/** Move focus for a menu key inside `panel`; true when the key was a menu move. */
export function moveMenuItemFocus(panel: HTMLElement | null, key: string): boolean {
  if (panel === null || typeof document === 'undefined') return false;
  const items = menuItemsIn(panel);
  const active = document.activeElement;
  const current = items.findIndex((item) => item === active || item.contains(active));
  const next = nextMenuIndex(key, current, items.length);
  if (next === null) return false;
  items[next]?.focus({ preventScroll: true });
  return true;
}

/** Frames to wait for a menu that paints a frame after `open` (a measured popover). */
const OPEN_FRAMES = 4;

/**
 * Wire a popover menu's keyboard while `open`: focus the first (or checked)
 * item once the panel is in the DOM, unless focus is already inside it; the
 * returned onKeyDown (put it on the panel) moves between items. A key a nested
 * handler already took (defaultPrevented) is left alone.
 */
export function useMenuKeys(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    let frames = 0;
    let raf = 0;
    const place = (): void => {
      const panel = panelRef.current;
      if (panel === null) {
        frames += 1;
        if (frames < OPEN_FRAMES) raf = requestAnimationFrame(place);
        return;
      }
      if (panel.contains(document.activeElement)) return;
      menuInitialItem(panel)?.focus({ preventScroll: true });
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, panelRef]);

  return {
    onKeyDown: (event) => {
      if (event.defaultPrevented) return;
      if (moveMenuItemFocus(panelRef.current, event.key)) event.preventDefault();
    },
  };
}
