// @vitest-environment jsdom
// Activity's solid rows (11 Nov 2026): Catch up, then Threads, as ui/ListCard
// solid rows in the lead slot; a row only while its count is above 0, no lead
// slot when both are 0; Catch up's long-press "Mark all as read". Guard: a
// solid row never renders at count 0 and the lead-row buttons never come back.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: async () => ({ data: [], error: null }) },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActivitySolidRows,
  MARK_ALL_AS_READ,
  TopbarActionsProvider,
  catchUpLabel,
  catchUpLine,
  threadsLabel,
  threadsLine,
  useActivitySolidRows,
  useTopbarActions,
} from '@/components/shell/topbar-actions';
import { ListScreen } from '@/components/shell/ListScreen';
import { TopbarSlots } from '@/components/shell/Topbar';
import { LIST_CARD_GRID, LIST_CARD_SOLID_GROUP } from '@/components/ui/ListCard';
import { ROW_HEIGHT, ROW_HEIGHT_PHONE } from '@/components/ui/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let reduce = false;
const animate = vi.fn(() => ({
  addEventListener: () => undefined,
  cancel: () => undefined,
  finish: () => undefined,
}));

beforeEach(() => {
  reduce = false;
  animate.mockClear();
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function mount(node: ReactElement): Promise<void> {
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(node);
  });
}

const threads = (): HTMLElement | null => document.querySelector('[data-topbar-threads]');
const catchUp = (): HTMLElement | null => document.querySelector('[data-topbar-catch-up]');
const solidRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-list-card-solid]'),
];
const noop = (): void => undefined;

function rows(over: Partial<Parameters<typeof ActivitySolidRows>[0]> = {}): ReactElement {
  return (
    <ActivitySolidRows
      unread={0}
      threads={0}
      onCatchUp={noop}
      onThreads={noop}
      onMarkAllRead={noop}
      {...over}
    />
  );
}

describe('a row shows only while its count is above 0', () => {
  it('both 0: nothing renders at all', async () => {
    await mount(rows());
    expect(document.querySelector('[data-activity-solid-rows]')).toBeNull();
    expect(solidRows()).toHaveLength(0);
    expect(catchUp()).toBeNull();
    expect(threads()).toBeNull();
  });

  it('only Catch up, only Threads: the other row is not in the DOM', async () => {
    await mount(rows({ unread: 3 }));
    expect(solidRows()).toHaveLength(1);
    expect(catchUp()).not.toBeNull();
    expect(threads()).toBeNull();
    await mount(rows({ threads: 2 }));
    expect(solidRows()).toHaveLength(1);
    expect(catchUp()).toBeNull();
    expect(threads()).not.toBeNull();
  });

  it.each([
    [0, 0],
    [0, 4],
    [5, 0],
    [1, 1],
    [150, 150],
  ])('guard: no solid row at count 0 (unread %i, threads %i)', async (unread, threadCount) => {
    await mount(rows({ unread, threads: threadCount }));
    const want = (unread > 0 ? 1 : 0) + (threadCount > 0 ? 1 : 0);
    expect(solidRows()).toHaveLength(want);
    for (const button of document.querySelectorAll(
      '[data-topbar-catch-up], [data-topbar-threads]',
    )) {
      expect(Number(button.getAttribute('data-count'))).toBeGreaterThan(0);
    }
    expect(document.querySelector('[data-activity-solid-rows]') !== null).toBe(want > 0);
  });

  it('both: Catch up first, then Threads, in the solid group grid', async () => {
    await mount(rows({ unread: 7, threads: 2 }));
    const buttons = [...document.querySelectorAll('[data-list-card-solid] > button')];
    expect(buttons.map((b) => b.hasAttribute('data-topbar-catch-up'))).toEqual([true, false]);
    expect(buttons.map((b) => b.hasAttribute('data-topbar-threads'))).toEqual([false, true]);
    const group = solidRows()[0]?.parentElement;
    expect(group?.className).toBe(LIST_CARD_SOLID_GROUP);
    for (const cls of LIST_CARD_GRID.split(' ')) expect(group?.className.split(' ')).toContain(cls);
    expect(group?.parentElement?.hasAttribute('data-activity-solid-rows')).toBe(true);
  });
});

describe('the rows are ui/ListCard solid rows', () => {
  it('72 tall (60 under 768), ink fill, the words, the count pill on-fill at the right edge', async () => {
    await mount(rows({ unread: 7, threads: 150 }));
    const [catchUpRow, threadsRow] = solidRows();
    for (const row of [catchUpRow, threadsRow]) {
      const cls = (row?.className ?? '').split(/\s+/);
      expect(cls).toContain(`md:h-${ROW_HEIGHT / 4}`);
      expect(cls).toContain(`h-${ROW_HEIGHT_PHONE / 4}`);
      // Under 768 the body is top-aligned: the tile and the count centre themselves.
      const centred = (q: string): boolean =>
        (row?.querySelector(q)?.className ?? '').split(/\s+/).includes('self-center');
      expect(centred('[data-list-card-picture]')).toBe(true);
      expect(centred('[data-list-card-count]')).toBe(true);
      expect(cls).toEqual(expect.arrayContaining(['bg-accent', 'text-accent-fg', '-mx-4', 'px-4']));
      expect(cls).toContain('hover:bg-accent-hover');
      expect(cls).toContain('select-none');
      expect(row?.hasAttribute('data-list-card')).toBe(true);
      expect(row?.querySelector('[data-list-card-time]')).toBeNull();
      expect(row?.querySelector('[data-list-card-tag]')).toBeNull();
      expect(row?.querySelector('[data-list-card-unread]')).toBeNull();
      expect(row?.querySelector('[data-list-card-tick]')).toBeNull();
      const pill = row?.querySelector('[data-list-card-count] [data-count-badge]');
      expect(pill?.getAttribute('data-count-badge')).toBe('on-fill');
      expect(row?.querySelector('[data-list-card-picture] svg')).not.toBeNull();
    }
    expect(catchUpRow?.querySelector('[data-list-card-title]')?.textContent).toBe('Catch up');
    expect(catchUpRow?.querySelector('[data-list-card-preview]')?.textContent).toBe('7 unread');
    expect(catchUpRow?.querySelector('[data-count-badge]')?.textContent).toBe('7');
    expect(threadsRow?.querySelector('[data-list-card-title]')?.textContent).toBe('Threads');
    expect(threadsRow?.querySelector('[data-list-card-preview]')?.textContent).toBe('150 new');
    expect(threadsRow?.querySelector('[data-count-badge]')?.textContent).toBe('99+');
  });

  it('the hooks: data-count and the accessible names on the row button', async () => {
    await mount(rows({ unread: 7, threads: 3 }));
    expect(catchUp()?.tagName).toBe('BUTTON');
    expect(catchUp()?.getAttribute('data-count')).toBe('7');
    expect(catchUp()?.getAttribute('aria-label')).toBe('Catch up, 7 unread');
    expect(threads()?.getAttribute('data-count')).toBe('3');
    expect(threads()?.getAttribute('aria-label')).toBe('Threads, 3 new');
  });

  it('words: "{n} unread", "{n} new"; aria "Threads, N new" / "Catch up, N unread"', () => {
    expect(catchUpLine(7)).toBe('7 unread');
    expect(threadsLine(3)).toBe('3 new');
    expect(threadsLabel(3)).toBe('Threads, 3 new');
    expect(threadsLabel(0)).toBe('Threads');
    expect(catchUpLabel(7)).toBe('Catch up, 7 unread');
    expect(catchUpLabel(0)).toBe('Catch up');
  });

  it('no motion: nothing animates when a row appears, leaves or its count mounts', async () => {
    await mount(rows({ unread: 1 }));
    await mount(rows({ unread: 1, threads: 2 }));
    await mount(rows({ threads: 2 }));
    await mount(rows());
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('taps and the long-press', () => {
  it('a tap on each row opens its place', async () => {
    const onCatchUp = vi.fn();
    const onThreads = vi.fn();
    await mount(rows({ unread: 2, threads: 2, onCatchUp, onThreads }));
    act(() => threads()?.click());
    expect(onThreads).toHaveBeenCalledTimes(1);
    expect(onCatchUp).not.toHaveBeenCalled();
    act(() => catchUp()?.click());
    expect(onCatchUp).toHaveBeenCalledTimes(1);
  });

  it('long-press Catch up: one row, Mark all as read, which marks all (no open)', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const markAll = vi.fn();
    await mount(rows({ unread: 4, onCatchUp: open, onMarkAllRead: markAll }));
    const button = catchUp();
    if (button === null) throw new Error('no button');
    act(() => {
      button.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      button.click();
    });
    expect(open).not.toHaveBeenCalled();
    const menuRows = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], button'),
    ].filter((b) => b.textContent?.includes(MARK_ALL_AS_READ));
    expect(menuRows).toHaveLength(1);
    act(() => menuRows[0]?.click());
    expect(markAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('right-click (laptop) opens the same menu', async () => {
    await mount(rows({ unread: 1 }));
    act(() => {
      catchUp()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).toContain(MARK_ALL_AS_READ);
  });

  it('the Threads row has no menu', async () => {
    await mount(rows({ threads: 1 }));
    act(() => {
      threads()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).not.toContain(MARK_ALL_AS_READ);
  });
});

describe('Topbar: the same two slots on every tab (Activity publishes none)', () => {
  function Publish() {
    useTopbarActions({});
    return null;
  }
  it('nothing published: the two fixed slots stay as empty boxes, no pair', async () => {
    await mount(
      <TopbarActionsProvider>
        <TopbarSlots />
        <Publish />
      </TopbarActionsProvider>,
    );
    expect(
      [...document.querySelectorAll('[data-topbar-slot]')].map((s) =>
        s.getAttribute('data-topbar-slot'),
      ),
    ).toEqual(['sort', 'primary']);
    expect(document.querySelector('[data-topbar-pair]')).toBeNull();
  });
});

describe('useActivitySolidRows: the lead slot', () => {
  function Screen({ unread }: { unread: number }) {
    const lead = useActivitySolidRows({
      workspaceId: null,
      totalUnread: unread,
      ready: true,
      onCatchUp: noop,
      onThreads: noop,
      onMarkAllRead: noop,
    });
    return (
      <ListScreen title="Activity" chips={<span />} lead={lead}>
        <span />
      </ListScreen>
    );
  }

  it('both counts 0: null, so ListScreen renders no lead slot', async () => {
    await mount(<Screen unread={0} />);
    expect(document.querySelector('[data-shell="lead"]')).toBeNull();
    expect(document.querySelector('[data-shell="content"]')).not.toBeNull();
  });

  it('unread above 0: the Catch up row inside the lead slot, at once', async () => {
    await mount(<Screen unread={3} />);
    const lead = document.querySelector('[data-shell="lead"]');
    expect(lead?.querySelector('[data-activity-solid-rows] [data-topbar-catch-up]')).not.toBeNull();
    expect(lead?.querySelector('[data-topbar-threads]')).toBeNull();
    await mount(<Screen unread={0} />);
    expect(document.querySelector('[data-shell="lead"]')).toBeNull();
  });
});

describe('guard: the lead-row buttons never come back', () => {
  // jsdom: import.meta.url is not a file URL; vitest runs from the repo root.
  const src = readFileSync(join(process.cwd(), 'src/components/shell/topbar-actions.tsx'), 'utf8');
  it('no pair button, box, pill or pulse in topbar-actions', () => {
    expect(src).not.toMatch(
      /PairButton|ThreadsButton|CatchUpButton|ACTIVITY_TOPBAR_|ACTIVITY_LEAD_ROW|useActivityLeadRow/,
    );
    expect(src).not.toMatch(/PULSE_|shouldPulse|usePulseOnRise|pulseRing|data-topbar-pulse/);
    expect(src).not.toMatch(/data-activity-lead-row|data-topbar-count|grid-cols-2/);
  });
  it('the rows are ListCard solid, never a Button', () => {
    const from = src.indexOf('// --- Activity: Catch up and Threads');
    expect(from).toBeGreaterThan(0);
    const activity = src.slice(from);
    expect(activity).not.toMatch(/<Button\b|<button\b/);
    expect(activity.match(/<ListCard\b/g)).toHaveLength(2);
    expect(activity.match(/\bsolid\b(?=\n)/g)).toHaveLength(2);
  });
  it('nothing mounts the old row', async () => {
    await mount(rows({ unread: 2, threads: 2 }));
    expect(
      document.querySelector(
        '[data-activity-lead-row], [data-topbar-pulse], [data-topbar-count], [data-topbar-catch-up-wrap]',
      ),
    ).toBeNull();
  });
});
