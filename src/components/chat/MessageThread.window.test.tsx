// @vitest-environment jsdom
// The thread's mounted window (src/lib/chat/thread-window.ts) as the thread
// list drives it, and the memoised message row. A full MessageThread needs the
// chat store, plan, star and toast providers, so the window is exercised
// through its hook with the list's own steps (open on the latest 50, 50 more
// at an edge, trim to 300 around the reader, older pages landing at the top),
// counting mounted rows; the row memo through the same stable caches and
// callbacks the list hands MessageRow, plus a check on the list's source.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act, memo, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  centreOn,
  createIdCallbacks,
  createStableCache,
  extendDown,
  extendUp,
  latestWindow,
  MAX_MOUNTED,
  STEP,
  trimWindow,
  useOptionalCallback,
  useStableCallback,
  useThreadWindow,
  type ThreadWindow,
} from '@/lib/chat/thread-window';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount(element: ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(element));
  return host;
}

const idsOf = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);

interface Controls {
  win: () => ThreadWindow;
  set: (next: ThreadWindow) => void;
  setIds: (ids: string[]) => void;
}

/** The list: one <li data-msg-id> per mounted row, as the thread renders them. */
function WindowList(props: { initial: string[]; controls: (c: Controls) => void }): ReactElement {
  const [ids, setIds] = useState(props.initial);
  const { win, set } = useThreadWindow(ids);
  props.controls({ win: () => win, set, setIds });
  return (
    <ul>
      {ids.slice(win.start, win.end).map((id) => (
        <li key={id} data-msg-id={id} />
      ))}
    </ul>
  );
}

function renderList(initial: string[]): { el: HTMLElement; c: () => Controls } {
  let controls: Controls | null = null;
  const el = mount(
    <WindowList
      initial={initial}
      controls={(c) => {
        controls = c;
      }}
    />,
  );
  return {
    el,
    c: () => {
      if (controls === null) throw new Error('not rendered');
      return controls;
    },
  };
}

const mountedIds = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll('[data-msg-id]')).map((n) => n.getAttribute('data-msg-id') ?? '');

describe('MessageThread window: mounted rows', () => {
  it('opens on the latest 50 of 500 loaded rows', () => {
    const { el } = renderList(idsOf(1, 500));
    const rows = mountedIds(el);
    expect(rows).toHaveLength(STEP);
    expect(rows[0]).toBe('m451');
    expect(rows[rows.length - 1]).toBe('m500');
  });

  it('paging through 500 rows up and back down keeps at most 300 mounted', () => {
    const { el, c } = renderList(idsOf(1, 500));
    const counts: number[] = [];
    // Up: the reader at the top of the window each time.
    for (let k = 0; k < 20 && c().win().start > 0; k += 1) {
      act(() => {
        const grown = extendUp(c().win());
        c().set(trimWindow(grown, grown.start));
      });
      counts.push(mountedIds(el).length);
    }
    expect(mountedIds(el)[0]).toBe('m1');
    // Down: the reader at the bottom each time; rows re-mount from memory.
    for (let k = 0; k < 20 && c().win().end < 500; k += 1) {
      act(() => {
        const grown = extendDown(c().win(), 500);
        c().set(trimWindow(grown, grown.end - 1));
      });
      counts.push(mountedIds(el).length);
    }
    const rows = mountedIds(el);
    expect(rows[rows.length - 1]).toBe('m500');
    expect(rows).toHaveLength(MAX_MOUNTED);
    expect(Math.max(...counts)).toBe(MAX_MOUNTED);
    for (const n of counts) expect(n).toBeLessThanOrEqual(MAX_MOUNTED);
  });

  it('an older page landing at the first loaded row mounts above; live rows land at the end', () => {
    const { el, c } = renderList(idsOf(451, 500));
    // The whole first page is mounted: the window starts at the first loaded row.
    expect(mountedIds(el)).toHaveLength(50);
    act(() => c().setIds(idsOf(401, 500)));
    expect(mountedIds(el)[0]).toBe('m401');
    act(() => c().setIds([...idsOf(401, 500), 'm501']));
    const rows = mountedIds(el);
    expect(rows[rows.length - 1]).toBe('m501');
    expect(rows).toHaveLength(101);
  });

  it('a window up in history keeps its rows as live rows and older pages land', () => {
    const { el, c } = renderList(idsOf(1, 500));
    act(() => c().set({ start: 100, end: 200 }));
    act(() => c().setIds(['m0', ...idsOf(1, 500), 'm501']));
    const rows = mountedIds(el);
    expect(rows[0]).toBe('m101');
    expect(rows[rows.length - 1]).toBe('m200');
  });

  it('a jump to an unmounted loaded row centres the window on it', () => {
    const { el, c } = renderList(idsOf(1, 500));
    expect(mountedIds(el)).not.toContain('m120');
    act(() => c().set(centreOn(500, 119)));
    const rows = mountedIds(el);
    expect(rows).toContain('m120');
    expect(rows.length).toBeLessThanOrEqual(2 * STEP + 1);
    expect(rows[0]).toBe('m70');
  });

  it('scroll to latest: back to the latest 50, the rest stay loaded', () => {
    const { el, c } = renderList(idsOf(1, 500));
    act(() => c().set({ start: 0, end: 300 }));
    act(() => c().set(latestWindow(500)));
    expect(mountedIds(el)).toEqual(idsOf(451, 500));
  });
});

describe('MessageThread window: memoised rows', () => {
  const renders = new Map<string, number>();
  interface ProbeProps {
    id: string;
    meta: { time: string; edited: boolean };
    onOpen: (id: string) => void;
    onToggle: () => void;
    onRetry?: ((id: string) => void) | undefined;
  }
  const Probe = memo(function Probe(props: ProbeProps): ReactElement {
    renders.set(props.id, (renders.get(props.id) ?? 0) + 1);
    return <li data-msg-id={props.id} />;
  });

  /** A parent that rebuilds every prop each render, as the list does. */
  function Parent(props: {
    tick: number;
    edited: string | null;
    onOpen: (id: string) => void;
    onRetry?: (id: string) => void;
  }): ReactElement {
    const [caches] = useState(() => ({
      meta: createStableCache<{ time: string; edited: boolean }>(),
      toggle: createIdCallbacks(() => {}),
    }));
    const onOpen = useStableCallback(props.onOpen);
    const onRetry = useOptionalCallback(props.onRetry);
    return (
      <ul data-tick={props.tick}>
        {['a', 'b', 'c'].map((id) => (
          <Probe
            key={id}
            id={id}
            meta={caches.meta(id, { time: '09:00', edited: props.edited === id })}
            onOpen={onOpen}
            onToggle={caches.toggle(id)}
            onRetry={onRetry}
          />
        ))}
      </ul>
    );
  }

  it('re-rendering the list with the same rows does not re-render them', () => {
    renders.clear();
    mount(<Parent tick={0} edited={null} onOpen={() => {}} onRetry={() => {}} />);
    expect([...renders.values()]).toEqual([1, 1, 1]);
    // New handler closures and freshly built meta objects with the same contents.
    act(() => root?.render(<Parent tick={1} edited={null} onOpen={() => {}} onRetry={() => {}} />));
    act(() => root?.render(<Parent tick={2} edited={null} onOpen={() => {}} onRetry={() => {}} />));
    expect([...renders.values()]).toEqual([1, 1, 1]);
    // One row's contents change: only that row renders again.
    act(() => root?.render(<Parent tick={3} edited="b" onOpen={() => {}} onRetry={() => {}} />));
    expect(renders.get('a')).toBe(1);
    expect(renders.get('b')).toBe(2);
    expect(renders.get('c')).toBe(1);
    // A callback going away (it hides its control) is a real change.
    act(() => root?.render(<Parent tick={4} edited="b" onOpen={() => {}} />));
    expect(renders.get('a')).toBe(2);
  });

  it('a stable callback runs the latest handler', () => {
    const calls: string[] = [];
    const grabbed: { open: ((id: string) => void) | null } = { open: null };
    function Grab(props: { onOpen: (id: string) => void }): ReactElement {
      grabbed.open = useStableCallback(props.onOpen);
      return <span />;
    }
    mount(<Grab onOpen={(id) => calls.push(`first:${id}`)} />);
    const first = grabbed.open;
    act(() => root?.render(<Grab onOpen={(id) => calls.push(`second:${id}`)} />));
    expect(grabbed.open).toBe(first);
    grabbed.open?.('x');
    expect(calls).toEqual(['second:x']);
  });
});

describe('MessageThread window: the list wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./MessageThread.tsx', import.meta.url)), 'utf8');
  const rowJsx = src.slice(
    src.indexOf('<MessageRow\n'),
    src.indexOf('selectingText={selectingTextId === row.message.id}'),
  );

  it('MessageRow is memoised', () => {
    expect(src).toContain('const MessageRow = memo(function MessageRow(props: MessageRowProps)');
  });

  it('the list hands each row no per-render closures or object literals', () => {
    expect(rowJsx.length).toBeGreaterThan(0);
    expect(rowJsx).not.toContain('=>');
    expect(rowJsx).not.toMatch(/=\{\{/);
    expect(rowJsx).not.toContain('function');
    // Object props come from the per-row caches.
    expect(rowJsx).toContain('meta={rowCaches.meta(id, row.meta)}');
    expect(rowJsx).toContain('rail={rowCaches.rail(id, rowRail)}');
    expect(rowJsx).toContain('postRefs={rowCaches.postRefs(id, {');
    expect(rowJsx).toContain('selection: rowCaches.selection(id, {');
    expect(rowJsx).toContain('mentions={rowMentions}');
  });

  it('renders only the window, with every data attribute kept', () => {
    expect(src).toContain('const { win, set: setWin } = useThreadWindow(ids);');
    expect(src).toContain('props.messages.slice(win.start, win.end)');
    expect(src).toContain('data-msg-id={message.id}');
    expect(src).toContain('data-unread-divider');
    expect(src).toContain('data-load-older=""');
  });
});
