import { useEffect, useRef } from 'react';

/**
 * One document keydown listener for every Escape-dismissable layer (sheet,
 * dialog, dropdown, date picker). Layers push while open and pop when closed;
 * Escape goes only to the top layer, so Escape in a Select inside a Sheet closes
 * the Select and leaves the Sheet (and its draft) alone.
 */
interface Layer {
  onEscape: () => void;
}

const stack: Layer[] = [];
let listening = false;

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  event.preventDefault();
  top.onEscape();
}

/** Push a layer; returns its pop. Popping a layer that is not on top keeps the order of the rest. */
export function pushEscapeLayer(onEscape: () => void): () => void {
  const layer: Layer = { onEscape };
  stack.push(layer);
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    const index = stack.indexOf(layer);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0 && listening) {
      document.removeEventListener('keydown', onKeyDown);
      listening = false;
    }
  };
}

/** Number of open layers (tests and diagnostics). */
export function escapeLayerCount(): number {
  return stack.length;
}

/**
 * Register a layer while `active`. The latest `onEscape` is always called (held
 * in a ref), so callers need not memoise it.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => handlerRef.current());
  }, [active]);
}
