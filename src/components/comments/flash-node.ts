// Scroll a DOM node into view and briefly ring it. Pure DOM, best-effort: when
// the target id is not currently rendered (e.g. an unloaded comments page) it is
// a no-op and never throws. Extracted from PostDetailPage's local flashTo so the
// caption/pin highlights and the email deep-link comment focus share one behavior.
export function flashNode(elementId: string): void {
  const node = document.getElementById(elementId);
  if (node === null) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('ring-2', 'ring-annotation-line');
  window.setTimeout(() => node.classList.remove('ring-2', 'ring-annotation-line'), 1200);
}
