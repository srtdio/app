// Uniformity pass (11c, 11d, 11f, 11g, 11i, 8): own-bubble card contrast, the
// laptop Chat list stepping aside for a docked Plan from 1180 to 1439px, the
// "1 selected" edge, the phone chat list edges, the tile time clear of the ⋯,
// and the swipe spring on the motion tokens. Class strings and source checks.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  CHAT_HOME_STACK,
  ROW_MORE_BUTTON,
  rowMoreClass,
  sectionLabelClass,
  tileBoxClass,
  TILE_TIME_ROW,
} from '@/components/chat/ChannelList';
import { chatListPaneClass } from '@/components/chat/ChatConnected';
import { OWN_BUBBLE_CONTENT } from '@/components/chat/MessageThread';
import { SelectionHeader } from '@/components/chat/SelectionBar';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const classes = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: readonly number[]): number {
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Source over: `top` at `alpha` on `under`. */
function over(top: readonly number[], alpha: number, under: readonly number[]): number[] {
  return under.map((u, i) => (top[i] ?? 0) * alpha + u * (1 - alpha));
}

describe('11c own-bubble post card', () => {
  it('card surfaces darken (black/12), secondary ink at opacity-90', () => {
    for (const token of [
      '[&_.bg-panel]:bg-black/[.12]',
      '[&_.bg-panel-2]:bg-black/[.12]',
      '[&_.bg-panel-3]:bg-black/[.12]',
      '[&_.text-fg-2]:text-accent-fg',
      '[&_.text-fg-2]:opacity-90',
      '[&_.text-fg-3]:text-accent-fg',
      '[&_.text-fg-3]:opacity-90',
    ]) {
      expect(OWN_BUBBLE_CONTENT).toContain(token);
    }
    for (const gone of [
      '[&_.bg-panel]:bg-white/[.16]',
      '[&_.bg-panel-2]:bg-white/[.16]',
      '[&_.bg-panel-3]:bg-white/[.16]',
      '[&_.text-fg-2]:opacity-80',
      '[&_.text-fg-3]:opacity-80',
    ]) {
      expect(OWN_BUBBLE_CONTENT).not.toContain(gone);
    }
  });

  it('"Waiting on approvers" and the Review chip reach 4.5:1 on the darkened card, both themes', () => {
    const css = read('../../../index.css');
    const fills = [...css.matchAll(/--bubble-own-rgb:\s*(\d+)\s+(\d+)\s+(\d+);/g)].map((m) =>
      [m[1], m[2], m[3]].map(Number),
    );
    // Light and dark at least.
    expect(fills.length).toBeGreaterThanOrEqual(2);
    const white = [255, 255, 255];
    const black = [0, 0, 0];
    for (const fill of fills) {
      const card = over(black, 0.12, fill);
      // Secondary ink (fg-2 / fg-3 -> accent-fg at opacity-90) on the card.
      expect(contrast(over(white, 0.9, card), card)).toBeGreaterThanOrEqual(4.5);
      // Primary ink (fg -> accent-fg) on the card.
      expect(contrast(white, card)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('11d laptop Chat with a Plan open', () => {
  const lifts = [
    'min-[1180px]:max-[1439px]:invisible',
    'min-[1180px]:max-[1439px]:absolute',
    'min-[1180px]:max-[1439px]:pointer-events-none',
  ];

  it('plan open: the list pane steps aside from 1180 to 1439px only', () => {
    const open = classes(chatListPaneClass(true));
    for (const c of lifts) expect(open).toContain(c);
    // 768 to 891px keeps its existing step-aside.
    expect(open).toContain('max-[891px]:invisible');
    // From 1440px all three panes show: nothing hides the list there.
    expect(open.some((c) => c.startsWith('min-[1440px]:'))).toBe(false);
    expect(open.filter((c) => c.includes('invisible'))).toEqual([
      'max-[891px]:invisible',
      'min-[1180px]:max-[1439px]:invisible',
    ]);
  });

  it('plan closed: the list returns (no step-aside classes at any width)', () => {
    const closed = chatListPaneClass(false);
    expect(closed).toBe('h-full w-full border-border md:w-72 md:border-r xl:w-[352px]');
    expect(closed).not.toContain('invisible');
  });

  it('set aside in place, never unmounted; the thread stays the same element so its scroll stays', () => {
    const src = read('../ChatConnected.tsx');
    expect(src).toContain('<div className={chatListPaneClass(planPanelOpen)}>');
    // The thread narrows beside the panel from 1180px, as before.
    expect(src).toContain("planPanelOpen && 'min-[1180px]:mr-[440px]'");
    // The thread's key is the chat only: opening or closing the plan never remounts it.
    expect(src).toContain('key={selected.channelId}');
    expect(src).not.toMatch(/key=\{[^}]*planPanelOpen/);
  });
});

describe('11f "1 selected" on the 16px edge', () => {
  it('the count carries pl-2 in both layouts (thread and Contact info select mode share it)', () => {
    for (const layout of ['touch', 'laptop'] as const) {
      const header = SelectionHeader({ count: 1, onCancel: () => undefined, layout });
      const count = (header.props as { children: unknown[] }).children[0] as {
        props: { className: string; children: string };
      };
      expect(count.props.children).toBe('1 selected');
      expect(classes(count.props.className)).toContain('pl-2');
    }
    expect(read('../ChatInfoTabs.tsx')).toContain('<SelectionHeader');
    expect(read('../MessageThread.tsx')).toContain('<SelectionHeader');
  });
});

describe('11g phone chat list edges', () => {
  it('cards and section labels start on the same 16px edge as search and chips', () => {
    expect(classes(CHAT_HOME_STACK)).toContain('px-4');
    expect(CHAT_HOME_STACK).not.toContain('px-[14px]');
    for (const first of [true, false]) {
      const label = classes(sectionLabelClass(first));
      expect(label.some((c) => /^(px|pl|pr|mx|ml)-/.test(c))).toBe(false);
    }
    // The search box and the chip row sit in the SectionHeader's px-4 rows.
    expect(read('../../shell/SectionHeader.tsx')).toContain("'px-4 md:px-6");
    expect(read('../ChannelList.tsx')).toContain('data-starred-home="" className="px-4');
  });
});

describe('11i tile time clear of the ⋯', () => {
  // px per Tailwind spacing step (0.25rem at 16px).
  const STEP = 4;
  const MORE_RIGHT = 1 * STEP; // rowMoreClass right-1
  const MORE_SIZE = 11 * STEP; // ROW_MORE_BUTTON w-11
  const GAP = 8;

  it('square tile: pr-11 inside the px-3 box leaves 8px before the corner ⋯', () => {
    expect(rowMoreClass('square')).toContain('right-1');
    expect(ROW_MORE_BUTTON).toContain('w-11');
    expect(tileBoxClass('square')).toContain('px-3');
    expect(classes(TILE_TIME_ROW)).toEqual(expect.arrayContaining(['w-full', 'pr-11']));
    const tilePad = 3 * STEP;
    expect(tilePad + 11 * STEP).toBeGreaterThanOrEqual(MORE_RIGHT + MORE_SIZE + GAP);
  });

  it('the time never truncates; only the spacer beside it gives way', () => {
    const src = read('../ChannelList.tsx');
    expect(src).toContain("cn('shrink-0 text-fg-2', TILE_TIME_TYPE)");
    expect(src).toContain('className="min-w-0 shrink grow basis-11"');
    expect(src).toContain('className="min-w-0 shrink-0 grow basis-0"');
  });

  it('wide tile: pr-14 keeps 8px before the ⋯; the name truncates, never the time', () => {
    expect(rowMoreClass('wide')).toContain('right-1');
    expect(classes(tileBoxClass('wide', true))).toContain('pr-14');
    expect(14 * STEP).toBeGreaterThanOrEqual(MORE_RIGHT + MORE_SIZE + GAP);
  });
});

describe('8 motion tokens in the thread', () => {
  it('the swipe spring uses DUR_SLOW_MS and the enter curve; hover fades use duration-fast', () => {
    const src = read('../MessageThread.tsx');
    expect(src).toContain('`${DUR_SLOW_MS}ms var(--ease-enter)`');
    expect(src).not.toContain('SWIPE_SPRING_MS');
    expect(src).not.toMatch(/ms ease-out|duration-\[\d+ms\]|duration-\d+\b/);
  });
});
