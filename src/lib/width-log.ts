// The width log, for finding what pushes a page wider than a real phone's
// screen (Safari then pans the page sideways when a field takes focus).
// Shown only in the ?paintlog=1 panel (src/components/dev/MarksPanel.tsx):
// startWidthLog() is called by that panel alone, so no normal visit listens to
// anything. A focus on any element is read once, a second later (after the
// keyboard and the box's own growth): the screen and page widths, the
// visual viewport's scale and offset, and every element past a screen edge,
// widest first. Never throws.

export interface WidthCulprit {
  /** Tag, id, data-* names and the start of the class list. */
  label: string;
  left: number;
  right: number;
  width: number;
}

export interface WidthSnapshot {
  /** What took focus (same label shape as a culprit). */
  focus: string;
  /** documentElement.clientWidth: the layout viewport. */
  screen: number;
  innerWidth: number;
  /** documentElement.scrollWidth: the page's own width. */
  page: number;
  scale: number;
  offsetLeft: number;
  culprits: WidthCulprit[];
}

/** How long after a focus the page is read. */
const READ_AFTER_MS = 1000;
/** At most this many elements are kept. */
const MAX_CULPRITS = 12;

let last: WidthSnapshot | null = null;
let started = false;

function labelOf(el: Element): string {
  const data =
    el instanceof HTMLElement
      ? Object.keys(el.dataset)
          .map((k) => `[${k}]`)
          .join('')
      : '';
  const id = el.id !== '' ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
  return `${el.tagName.toLowerCase()}${id}${data} ${cls}`.trim();
}

/** Read the page now. Pure DOM read; returns null without a document. */
export function readWidths(focusLabel = ''): WidthSnapshot | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  try {
    const root = document.documentElement;
    const screen = root.clientWidth;
    const culprits: WidthCulprit[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Rects are in layout viewport coordinates, less the page's own scroll.
      if (r.right > screen + 1 || r.left < -1) {
        culprits.push({
          label: labelOf(el),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        });
      }
    }
    culprits.sort((a, b) => b.right - a.right || a.left - b.left);
    return {
      focus: focusLabel,
      screen,
      innerWidth: window.innerWidth,
      page: root.scrollWidth,
      scale: Math.round((window.visualViewport?.scale ?? 1) * 1000) / 1000,
      offsetLeft: Math.round(window.visualViewport?.offsetLeft ?? 0),
      culprits: culprits.slice(0, MAX_CULPRITS),
    };
  } catch {
    return null;
  }
}

/** The last reading after a focus, or null. */
export function lastWidths(): WidthSnapshot | null {
  return last;
}

/** Start reading after each focus. Idempotent; the panel calls it once. */
export function startWidthLog(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  let timer = 0;
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target instanceof Element ? labelOf(event.target) : '';
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        last = readWidths(target) ?? last;
      }, READ_AFTER_MS);
    },
    true,
  );
}

/** Plain text for Copy: one line per figure, then one per element. */
export function formatWidths(s: WidthSnapshot | null): string {
  if (s === null) return 'Widths: no focus read yet';
  return [
    `Widths after focus on: ${s.focus}`,
    `screen ${s.screen} inner ${s.innerWidth} page ${s.page} scale ${s.scale} offsetLeft ${s.offsetLeft}`,
    ...s.culprits.map((c) => `${c.left}..${c.right} (${c.width}) ${c.label}`),
  ].join('\n');
}
