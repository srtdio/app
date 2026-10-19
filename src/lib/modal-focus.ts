// Focus for modal layers (Sheet, ConfirmDialog, the lightbox, the link check
// sheet, the palette, the preview panel). On open, focus moves into the panel:
// the element the caller names, else the first focusable control, else the
// panel itself (tabindex -1). On a touch device a text field is never the
// landing spot, so no keyboard pops. Tab and Shift+Tab wrap inside the panel.
// On close (or unmount), focus returns to the element focused before the open
// if it is still in the document. Layers nest: one document listener, and only
// the top open layer traps, so a confirm over a sheet traps for itself alone.

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), video[controls], audio[controls], ' +
  '[contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Every focusable control inside `root`, in DOM order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'file',
  'color',
  'image',
]);

/** Whether focusing `el` opens a keyboard on a phone. */
export function isTextField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/** A touch-first device (coarse pointer, the create sheet's own rule): never land focus on a text field. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Where focus lands on open: `preferred`, else the first control, else the
 * panel; a text field on a touch device becomes the panel. Pure.
 */
export function initialFocusTarget(
  root: HTMLElement,
  preferred: HTMLElement | null,
  touch: boolean,
): HTMLElement {
  const target = preferred ?? focusableIn(root)[0] ?? root;
  return touch && isTextField(target) ? root : target;
}

interface Layer {
  panel: RefObject<HTMLElement | null>;
}

const layers: Layer[] = [];
let listening = false;

/** The Tab trap: only the top layer's panel; focus outside it wraps back in. */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const top = layers[layers.length - 1];
  const root = top?.panel.current ?? null;
  if (root === null) return;
  const items = focusableIn(root);
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active) && active !== root;
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    focusPanel(root);
    return;
  }
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function focusPanel(root: HTMLElement): void {
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
}

/** Push a layer; returns its pop. Popping a layer that is not on top keeps the rest in order. */
export function pushModalLayer(panel: RefObject<HTMLElement | null>): () => void {
  const layer: Layer = { panel };
  layers.push(layer);
  if (!listening && typeof document !== 'undefined') {
    // Capture: a layer that stops keydown propagation for its own reasons
    // (the link check sheet) still gets its Tab trapped.
    document.addEventListener('keydown', onKeyDown, true);
    listening = true;
  }
  return () => {
    const at = layers.indexOf(layer);
    if (at !== -1) layers.splice(at, 1);
    if (layers.length === 0 && listening) {
      document.removeEventListener('keydown', onKeyDown, true);
      listening = false;
    }
  };
}

/** Number of open modal layers (tests and diagnostics). */
export function modalLayerCount(): number {
  return layers.length;
}

export interface ModalFocusOptions {
  /** Where focus lands on open (e.g. the primary action). Default: the first control, else the panel. */
  initial?: () => HTMLElement | null | undefined;
}

/**
 * Own focus while `open`: move it in, trap Tab, hand it back on close. Pass
 * `open` as "open and the panel is in the DOM" for layers that mount their
 * panel one render after their open prop. A layer that already placed focus
 * inside itself (an opener focusing a field in its own tap) keeps it.
 */
export function useModalFocus(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: ModalFocusOptions = {},
): void {
  const initialRef = useRef(options.initial);
  initialRef.current = options.initial;
  useEffect(() => {
    if (!open) return;
    const root = panelRef.current;
    const before = document.activeElement;
    const alreadyInside =
      root !== null && before instanceof HTMLElement && before !== root && root.contains(before);
    const opener =
      !alreadyInside && before instanceof HTMLElement && before !== document.body ? before : null;
    const pop = pushModalLayer(panelRef);
    if (root !== null && !alreadyInside) {
      const target = initialFocusTarget(root, initialRef.current?.() ?? null, isTouchDevice());
      if (target === root) focusPanel(root);
      else target.focus({ preventScroll: true });
    }
    return () => {
      pop();
      if (opener === null || !opener.isConnected) return;
      // Hand focus back only when the layer still holds it (or it fell to the
      // body); a caller that moved it on purpose keeps its choice.
      const active = document.activeElement;
      const held =
        active === null || active === document.body || (root !== null && root.contains(active));
      if (held) opener.focus({ preventScroll: true });
    };
  }, [open, panelRef]);
}
