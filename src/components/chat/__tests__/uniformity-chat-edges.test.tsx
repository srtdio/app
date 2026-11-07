// Uniformity pass (11c, 11d, 11f, 11g, 11i, 8): own-bubble card contrast, the
// laptop Chat list stepping aside for a docked Plan from 1180 to 1439px, the
// "1 selected" edge, the phone chat list edges, the time clear of the ⋯ (the
// parts own the slots), and the swipe spring on the motion tokens. Class strings and source checks.
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
  CHAT_HOME_EDGE,
  CHAT_HOME_STACK,
  CHAT_ROW_LIST,
  sectionLabelClass,
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
  it('card surfaces take an on-bubble/12 overlay, secondary ink at full accent-fg (no opacity)', () => {
    for (const token of [
      '[&_.bg-panel]:bg-on-bubble/[.12]',
      '[&_.bg-panel-2]:bg-on-bubble/[.12]',
      '[&_.bg-panel-3]:bg-on-bubble/[.12]',
      '[&_.text-fg-2]:text-accent-fg',
      '[&_.text-fg-3]:text-accent-fg',
    ]) {
      expect(OWN_BUBBLE_CONTENT).toContain(token);
    }
    for (const gone of [
      '[&_.bg-panel]:bg-white/[.16]',
      '[&_.bg-panel-2]:bg-white/[.16]',
      '[&_.bg-panel-3]:bg-white/[.16]',
      '[&_.bg-panel]:bg-black/[.12]',
      '[&_.bg-panel-2]:bg-black/[.12]',
      '[&_.bg-panel-3]:bg-black/[.12]',
      '[&_.text-fg-2]:opacity-80',
      '[&_.text-fg-3]:opacity-80',
    ]) {
      expect(OWN_BUBBLE_CONTENT).not.toContain(gone);
    }
  });

  it('"Waiting on approvers" and the Review chip reach 4.5:1 on the darkened card, both themes', () => {
    const css = read('../../../index.css');
    // Each theme block pairs its own bubble fill with its own accent-fg ink
    // (white on the black light bubble, near-black on the off-white dark one).
    const triplet = (block: string, name: string): number[] => {
      const m = new RegExp(`--${name}-rgb:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+);`).exec(block);
      return m === null ? [] : [m[1], m[2], m[3]].map(Number);
    };
    const blocks = [/^:root \{([\s\S]*?)^\}/m, /^\.dark \{([\s\S]*?)^\}/m].map(
      (re) => re.exec(css)?.[1] ?? '',
    );
    // The card overlay is on-bubble/12 (white over the black light bubble,
    // near-black over the off-white dark one).
    const pairs = blocks.map(
      (b) => [triplet(b, 'bubble-own'), triplet(b, 'accent-fg'), triplet(b, 'on-bubble')] as const,
    );
    // Light and dark.
    expect(pairs.map(([fill, ink, line]) => fill.length + ink.length + line.length)).toEqual([
      9, 9,
    ]);
    for (const [fill, ink, line] of pairs) {
      const card = over(line, 0.12, fill);
      // Secondary ink (fg-2 / fg-3 -> accent-fg, solid) on the card.
      expect(contrast(ink, card)).toBeGreaterThanOrEqual(4.5);
      // Primary ink (fg -> accent-fg) on the card.
      expect(contrast(ink, card)).toBeGreaterThanOrEqual(4.5);
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
    expect(closed).toBe('h-full w-full border-border md:w-72 md:border-r xl:w-chat-list');
    expect(closed).not.toContain('invisible');
  });

  it('set aside in place, never unmounted; the thread stays the same element so its scroll stays', () => {
    const src = read('../ChatConnected.tsx');
    expect(src).toContain('className={chatListPaneClass(planPanelOpen, listPageScroll)}>');
    // The thread narrows beside the panel from 1180px, as before.
    expect(src).toContain("planPanelOpen && 'min-[1180px]:mr-plan-panel'");
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
  it('cards and section labels sit on the 16px edge with search and chips', () => {
    // The stack has no side padding; the card lists and the labels carry the 16 edge.
    expect(classes(CHAT_HOME_STACK).some((c) => /^(px|pl|pr)-/.test(c))).toBe(false);
    expect(CHAT_HOME_EDGE).toBe('px-4');
    expect(classes(CHAT_ROW_LIST)).toContain('px-4');
    expect(read('../ChannelList.tsx')).toContain('<ListCard');
    for (const first of [true, false]) {
      const label = classes(sectionLabelClass(first));
      expect(label).toContain('px-4');
      expect(label.some((c) => /^(pl|pr|mx|ml)-/.test(c))).toBe(false);
    }
    // The search box and the chip row sit in the SectionHeader's px-4 rows.
    expect(read('../../shell/SectionHeader.tsx')).toContain("'px-4 md:px-6");
  });
});

describe('11i the ⋯ never covers the time (B1b: parts own the slots)', () => {
  it('a chat card: the ⋯ is line 3 trailing, after the time, never over it', () => {
    const card = read('../../ui/ListCard.tsx');
    expect(card.indexOf('data-list-card-more')).toBeGreaterThan(
      card.indexOf('data-list-card-time'),
    );
    expect(card).not.toMatch(/data-list-card-more=""[^\n]*absolute/);
  });

  it('a person is the same Row: no Tile in the chat list', () => {
    expect(read('../ChannelList.tsx')).not.toContain('<Tile');
  });
});

describe('8 motion tokens in the thread', () => {
  it('the swipe spring uses DUR_SLOW_MS and the enter curve; hover controls never fade', () => {
    // The spring lives in the motion module (lib/motion/swipe.ts, paintSwipe);
    // the thread paints through it and sets no timing of its own.
    const swipe = read('../../../lib/motion/swipe.ts');
    expect(swipe).toContain('`${DUR_SLOW_MS}ms var(--ease-enter)`');
    expect(swipe).not.toContain('SWIPE_SPRING_MS');
    const src = read('../MessageThread.tsx');
    expect(src).toContain('paintSwipe');
    expect(src).not.toContain('SWIPE_SPRING_MS');
    expect(src).not.toMatch(/ms ease-out|duration-\[\d+ms\]|duration-\d+\b|ease-enter/);
  });
});
