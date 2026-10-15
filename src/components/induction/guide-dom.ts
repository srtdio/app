// Live DOM reads for the guide layer. Every rect is read from the element at
// the moment it is asked for (getBoundingClientRect), never kept.

import { inductionSelector, type InductionKey, type Rect } from '@/lib/induction';

/** The guide's own root, so its nodes never count as page content. */
export const LAYER_ATTR = 'data-induction-layer';

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return window.getComputedStyle(el).visibility !== 'hidden';
}

export type Found = { found: false } | { found: true; el: HTMLElement; key: InductionKey };

/** The first visible control for the keys, in key order. */
export function findTarget(keys: readonly InductionKey[]): Found {
  for (const key of keys) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(inductionSelector(key)))) {
      if (shown(el)) return { found: true, el, key };
    }
  }
  return { found: false };
}

export type OpenDialog = { open: false } | { open: true; el: HTMLElement };

/** The top-most open modal sheet or dialog (portals append, so the last one). */
export function topDialog(): OpenDialog {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
  ).filter((el) => el.closest(`[${LAYER_ATTR}]`) === null && shown(el));
  const last = all[all.length - 1];
  return last === undefined ? { open: false } : { open: true, el: last };
}

/** The dialog's title rect: its first heading, else its top edge. */
export function dialogTitleRect(dialog: HTMLElement): Rect {
  const heading = dialog.querySelector('h1, h2, h3');
  if (heading !== null) return rectOf(heading);
  const r = rectOf(dialog);
  return { top: r.top + 8, left: r.left + 16, width: r.width - 32, height: 0 };
}

/** The control's own corner radius in px (its top-left corner). */
export function radiusOf(el: Element): number {
  const value = Number.parseFloat(window.getComputedStyle(el).borderTopLeftRadius);
  return Number.isFinite(value) ? value : 0;
}

export function inLayer(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el !== null && el.closest(`[${LAYER_ATTR}]`) !== null;
}
