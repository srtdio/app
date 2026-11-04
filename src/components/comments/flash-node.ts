// Scroll a DOM node into view and briefly mark it selected (lit-selected). Pure
// DOM, best-effort: when the target id is not currently rendered (e.g. an
// unloaded comments page) it is a no-op and never throws. Extracted from
// PostDetailPage's local flashTo so the caption/pin highlights and the email
// deep-link comment focus share one behavior.
//
// The node is centred in its own scroller (the shell's main), never by the
// window: scrollIntoView also scrolls the document when the scroller cannot
// centre a row near the end of its content, and the viewport lock
// (src/lib/viewport-lock.ts) snaps the document back to 0 on the next focus
// change, so the next tap (Reply on that comment) landed on whatever slid
// under the finger. Only a node with no scrolling ancestor falls back to
// scrollIntoView.

import { centredTop, scrollParent } from '@/lib/focus-target';

const FLASH_CLASS = 'lit-selected';
const FLASH_MS = 1200;

export function flashNode(elementId: string): void {
  const node = document.getElementById(elementId);
  if (node === null) return;
  const scroller = scrollParent(node);
  if (scroller !== null) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const top = centredTop({
      scrollTop: scroller.scrollTop,
      viewTop: view.top,
      viewHeight: view.height,
      elTop: rect.top,
      elHeight: rect.height,
      marginTop: parseFloat(style.scrollMarginTop) || 0,
      marginBottom: parseFloat(style.scrollMarginBottom) || 0,
    });
    scroller.scrollTo({ top, behavior: 'smooth' });
  } else {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // The arrival highlight is the one selected edge (lit-selected), never a ring.
  node.classList.add(FLASH_CLASS);
  window.setTimeout(() => node.classList.remove(FLASH_CLASS), FLASH_MS);
}
