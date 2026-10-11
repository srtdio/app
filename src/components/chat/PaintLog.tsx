// An opt-in paint log for chasing a flicker on a real phone. Off by default:
// it turns on only when the URL carries ?paintlog=1 (kept for the tab session,
// so in-app navigation keeps it; ?paintlog=0 turns it off). When off, every
// call here is a no-op and the overlay renders nothing. When on, a small fixed
// panel lists, with millisecond timestamps (performance.now), each plan card
// mount, unmount, skeleton and render, each ticker state change, every scroll
// the thread makes itself, and, sampled after each frame, every thread scroll
// and plan card move, with a Copy button for sending the log. Tokens only.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';

/** The URL parameter that turns the log on (1) or off (0). */
export const PAINT_LOG_PARAM = 'paintlog';
/** Entries kept; the oldest go first. */
export const PAINT_LOG_LIMIT = 1_000;
const STORAGE_KEY = 'sorted:paintlog';

/** Whether the log is on for this URL and the tab's stored choice. Pure. */
export function paintLogWanted(search: string, stored: string | null): boolean {
  const value = new URLSearchParams(search).get(PAINT_LOG_PARAM);
  if (value === '1') return true;
  if (value === '0') return false;
  return stored === '1';
}

export interface PaintLogEntry {
  /** performance.now() in ms. */
  at: number;
  what: string;
}

export interface PaintLogStore {
  enabled: () => boolean;
  push: (what: string) => void;
  /** The entries, oldest first (a new array after each change). */
  entries: () => readonly PaintLogEntry[];
  subscribe: (listener: () => void) => () => void;
  clear: () => void;
}

/** One log. Disabled: push does nothing and nobody is notified. */
export function createPaintLog(opts: {
  enabled: boolean;
  now: () => number;
  limit?: number;
}): PaintLogStore {
  const limit = opts.limit ?? PAINT_LOG_LIMIT;
  const listeners = new Set<() => void>();
  let list: readonly PaintLogEntry[] = [];
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  return {
    enabled: () => opts.enabled,
    push(what) {
      if (!opts.enabled) return;
      const next = [...list, { at: opts.now(), what }];
      list = next.length > limit ? next.slice(next.length - limit) : next;
      emit();
    },
    entries: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      list = [];
      emit();
    },
  };
}

/** The copied text: a header, then one line per entry. Pure. */
export function formatPaintLog(
  entries: readonly PaintLogEntry[],
  header: readonly string[],
): string {
  return [...header, ...entries.map((e) => `${e.at.toFixed(1)} ${e.what}`)].join('\n');
}

function readEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  const on = paintLogWanted(window.location.search, stored);
  // Storage is touched only when the URL asks (normal visits leave it alone).
  const asked = new URLSearchParams(window.location.search).get(PAINT_LOG_PARAM);
  try {
    if (asked === '1') window.sessionStorage.setItem(STORAGE_KEY, '1');
    if (asked === '0') window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the log follows the URL alone.
  }
  return on;
}

const store = createPaintLog({
  enabled: readEnabled(),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
});

/** Whether the paint log is on for this tab. */
export function paintLogOn(): boolean {
  return store.enabled();
}

/** Add one line (a no-op unless the log is on). */
export function paintLog(what: string): void {
  store.push(what);
}

let instances = 0;

/**
 * Log a component's mount and unmount (numbered per instance, so a remount
 * shows as a new number) and every commit with its state. A no-op when off.
 */
export function usePaintLogCommit(label: string, state: string): void {
  const idRef = useRef(0);
  useEffect(() => {
    if (!store.enabled()) return;
    instances += 1;
    const id = instances;
    idRef.current = id;
    store.push(`${label} [${id}] mount`);
    return () => store.push(`${label} [${id}] unmount`);
  }, [label]);
  useEffect(() => {
    if (store.enabled()) store.push(`${label} [${idRef.current}] render ${state}`);
  });
}

/** The panel, portalled to the body; nothing at all when the log is off. */
export function PaintLogOverlay(): ReactElement | null {
  if (!store.enabled() || typeof document === 'undefined') return null;
  return createPortal(<PaintLogPanel />, document.body);
}

/**
 * After each frame (a task posted from requestAnimationFrame runs after that
 * frame's layout, resize observers and paint): the thread list's scrollTop
 * and every plan card's on-screen top and node identity. Logs changes only.
 */
function useFrameSampler(): void {
  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const channel = new MessageChannel();
    let lastList: Element | null = null;
    let lastTop: number | null = null;
    let lastHeight: number | null = null;
    const cardTops = new Map<string, number>();
    const cardNodes = new WeakSet<Element>();
    channel.port1.onmessage = () => {
      if (stopped) return;
      const list = document.querySelector('[data-thread-viewport] > ul');
      if (list !== null) {
        const top = Math.round(list.scrollTop);
        const height = list.scrollHeight;
        if (list !== lastList) {
          store.push(`thread list ${lastList === null ? 'mounted' : 'replaced'} at ${top}`);
        } else if (lastTop !== null && top !== lastTop) {
          const grew = lastHeight !== null ? height - lastHeight : 0;
          const kind = top - lastTop === grew ? 'follow' : 'jump';
          store.push(
            `thread scroll ${kind} ${lastTop} -> ${top} (height ${lastHeight ?? '?'} -> ${height})`,
          );
        }
        lastList = list;
        lastTop = top;
        lastHeight = height;
      }
      const seen = new Set<string>();
      for (const card of document.querySelectorAll('[data-plan-card]')) {
        const id = card.getAttribute('data-plan-card') ?? '';
        seen.add(id);
        if (!cardNodes.has(card)) {
          cardNodes.add(card);
          store.push(`plan card ${id} node painted`);
        }
        const top = Math.round(card.getBoundingClientRect().top);
        const was = cardTops.get(id);
        if (was !== undefined && was !== top) store.push(`plan card ${id} moved ${was} -> ${top}`);
        cardTops.set(id, top);
      }
      for (const id of [...cardTops.keys()]) {
        if (!seen.has(id)) {
          cardTops.delete(id);
          store.push(`plan card ${id} gone`);
        }
      }
    };
    const frame = (): void => {
      channel.port2.postMessage(null);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    };
  }, []);
}

const BUTTON =
  'min-h-[44px] min-w-[44px] rounded-md px-3 text-sm font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

function PaintLogPanel(): ReactElement {
  const entries = useSyncExternalStore(store.subscribe, store.entries, store.entries);
  const [open, setOpen] = useState(true);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const listRef = useRef<HTMLOListElement | null>(null);
  useFrameSampler();
  // The newest line stays in view while the panel is open.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [entries, open]);
  const text = (): string =>
    formatPaintLog(store.entries(), [
      `paint log, origin ${new Date(performance.timeOrigin).toISOString()}`,
      `ua ${navigator.userAgent}`,
      `viewport ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}`,
      `path ${window.location.pathname}`,
    ]);
  const onCopy = (): void => {
    const clipboard = 'clipboard' in navigator ? navigator.clipboard : null;
    if (clipboard === null) {
      setCopy('failed');
      return;
    }
    clipboard.writeText(text()).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  return (
    <div
      data-paint-log=""
      className="fixed inset-x-2 bottom-2 z-[70] flex flex-col overflow-hidden rounded-lg border border-border bg-panel text-fg shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex-1 truncate text-xs font-semibold text-fg-2">
          {`Paint log (${entries.length})`}
        </span>
        <button type="button" data-paint-log-copy="" onClick={onCopy} className={BUTTON}>
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Select below' : 'Copy'}
        </button>
        <button type="button" onClick={() => store.clear()} className={BUTTON}>
          Clear
        </button>
        <button type="button" onClick={() => setOpen((v) => !v)} className={BUTTON}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && copy === 'failed' ? (
        <textarea
          readOnly
          value={text()}
          onFocus={(e) => e.currentTarget.select()}
          className="h-[30vh] w-full resize-none bg-panel-2 p-2 font-mono text-[11px] leading-4 text-fg"
        />
      ) : open ? (
        <ol
          ref={listRef}
          className="max-h-[30vh] overflow-y-auto p-2 font-mono text-[11px] leading-4"
        >
          {entries.map((e, i) => (
            <li key={i} className="whitespace-pre-wrap break-all">
              <span className="text-fg-3">{e.at.toFixed(1)}</span> {e.what}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
