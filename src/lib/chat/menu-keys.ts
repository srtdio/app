// Arrow-key focus for the chat's popover menus (FB2): menus are popovers, not
// modal dialogs, so they carry no aria-modal; Arrow Down / Up move between
// their items (wrapping), Home / End jump to the ends. Escape and Tab stay
// with the menu's own handlers.

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

/** The next item's index for a key, or null when the key is not a menu move. Pure. */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Move focus inside `container` for an arrow key. True when the key was a
 * menu move (the caller prevents its default scroll).
 */
export function moveMenuFocus(container: HTMLElement | null, key: string): boolean {
  if (container === null) return false;
  const items = Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  const active = document.activeElement;
  const current = items.findIndex((item) => item === active || item.contains(active));
  const next = nextMenuIndex(key, current, items.length);
  if (next === null) return false;
  items[next]?.focus({ preventScroll: true });
  return true;
}
