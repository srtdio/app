// Live DOM reads for the guide layer. Every rect is read from the element at
// the moment it is asked for (getBoundingClientRect), never kept.

import { inductionSelector, type InductionKey, type Rect } from '@/lib/induction';

/** The guide's own root, so its nodes never count as page content. */
export const LAYER_ATTR = 'data-induction-layer';

/** The guide's own interactive chrome (the bar, the cards): taps there are never swallowed. */
export const CHROME_ATTR = 'data-induction-chrome';

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

/**
 * Narrows one key to the element whose attribute holds a value: the review
 * post's row (data-induction-post), the default group's row
 * (data-induction-channel). strict: no match boxes nothing; else the first
 * shown element stands in.
 */
export interface TargetQualifier {
  attr: string;
  value: string;
  strict: boolean;
}

export type Qualifiers = Partial<Record<InductionKey, TargetQualifier>>;

function findKey(
  key: InductionKey,
  qualifier: TargetQualifier | undefined,
): HTMLElement | undefined {
  const all = Array.from(document.querySelectorAll<HTMLElement>(inductionSelector(key))).filter(
    shown,
  );
  if (qualifier === undefined) return all[0];
  const match = all.find((el) => el.getAttribute(qualifier.attr) === qualifier.value);
  return match ?? (qualifier.strict ? undefined : all[0]);
}

/** The first visible control for the keys, in key order, narrowed by any qualifier. */
export function findTarget(keys: readonly InductionKey[], qualifiers: Qualifiers = {}): Found {
  for (const key of keys) {
    const el = findKey(key, qualifiers[key]);
    if (el !== undefined) return { found: true, el, key };
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

/** The control's own corner radius in px (its top-left corner). */
export function radiusOf(el: Element): number {
  const value = Number.parseFloat(window.getComputedStyle(el).borderTopLeftRadius);
  return Number.isFinite(value) ? value : 0;
}

export function inLayer(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el !== null && el.closest(`[${LAYER_ATTR}]`) !== null;
}

export function inChrome(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el !== null && el.closest(`[${CHROME_ATTR}]`) !== null;
}

const TEXT_FIELD =
  'textarea, [contenteditable=""], [contenteditable="true"], input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"]';

/** The text field a control is or holds (input, textarea, contenteditable), else undefined. */
export function textFieldOf(el: HTMLElement): HTMLElement | undefined {
  if (el.matches(TEXT_FIELD)) return el;
  return el.querySelector<HTMLElement>(TEXT_FIELD) ?? undefined;
}

/** A text field's current value, trimmed. */
export function fieldValue(field: HTMLElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value.trim();
  }
  return (field.textContent ?? '').trim();
}
