// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({
  chat: 0,
  inbox: 0,
  plan: 0,
  newest: null as { planId: string; itemId: string; commentId: string | null } | null,
}));

vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ state: {} }),
}));
vi.mock('@/lib/chat/chat-store', () => ({ selectTotalUnread: () => counts.chat }));
vi.mock('@/components/shell/InboxStoreProvider', () => ({
  useInboxStore: () => ({ unreadCount: counts.inbox }),
}));
vi.mock('@/lib/inbox/unread-entities', () => ({
  usePlanItemsUnreadTotal: () => counts.plan,
  useNewestPlanUnread: () => counts.newest,
  planTabHref: (
    tab: string,
    newest: { planId: string; itemId: string; commentId: string | null } | null,
  ) =>
    newest === null
      ? tab
      : `/plan/${newest.planId}?item=${newest.itemId}${newest.commentId !== null ? `&comment=${newest.commentId}` : ''}`,
  unreadCommentsLabel: (n: number) => (n === 1 ? '1 unread comment' : `${n} unread comments`),
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  BottomTabs,
  PHONE_BAR_OFFSETS,
  chatTabLabel,
  dockShrinkNext,
  planTabLabel,
  tabClass,
  useDockShrunk,
} from '@/components/shell/BottomTabs';
import { MOVE_CLASS } from '@/lib/motion';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { INDUCTION_KEYS } from '@/lib/induction';
import { BOTTOM_ANCHOR_ATTR } from '@/lib/bottom-inset';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(path: string, chat = 0, inbox = 0): HTMLDivElement {
  counts.chat = chat;
  counts.inbox = inbox;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const node: ReactNode = (
    <MemoryRouter initialEntries={[path]}>
      <BottomTabs />
    </MemoryRouter>
  );
  act(() => root?.render(node));
  return host;
}

afterEach(() => {
  counts.plan = 0;
  counts.newest = null;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function nav(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('nav');
  if (el === null) throw new Error('no nav');
  return el;
}

function pillLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-tab-pill] > a'));
}

function chatLink(container: HTMLElement): HTMLAnchorElement {
  const el = container.querySelector<HTMLAnchorElement>('[data-chat-tab]');
  if (el === null) throw new Error('no chat tab');
  return el;
}

function classes(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/);
}

describe('BottomTabs: floating pill plus Chat circle (CLAUDE.md phone nav)', () => {
  it('guard: the pill reads Pipeline, Briefs, Assets, Plan, Activity and Chat sits alone to its right', () => {
    const container = render('/pipeline');
    expect(pillLinks(container).map((a) => a.getAttribute('href'))).toEqual([
      '/pipeline',
      '/briefs',
      '/assets',
      '/plan',
      '/notifications',
    ]);
    const row = Array.from(nav(container).children);
    expect(row).toHaveLength(2);
    expect(row[0]?.hasAttribute('data-tab-pill')).toBe(true);
    expect(row[1]).toBe(chatLink(container));
    expect(chatLink(container).getAttribute('href')).toBe('/chat');
    // The phone order is PRIMARY_NAV minus Chat, then Activity.
    expect(PRIMARY_NAV.filter((i) => i.showChatBadge !== true).map((i) => i.to)).toEqual([
      '/pipeline',
      '/briefs',
      '/assets',
      '/plan',
    ]);
  });

  it('guard: the row floats centred, 16px above the bottom, only as wide as its tabs, phone only', () => {
    expect(PHONE_BAR_OFFSETS).toBe(
      'left-1/2 -translate-x-1/2 bottom-[calc(16px+env(safe-area-inset-bottom))]',
    );
    // Never stretched edge to edge: no right offset, no 12px side insets.
    expect(PHONE_BAR_OFFSETS).not.toMatch(/\bright-|12px/);
    const container = render('/pipeline');
    const cls = classes(nav(container));
    for (const c of ['md:hidden', 'fixed', 'gap-2', ...PHONE_BAR_OFFSETS.split(' ')]) {
      expect(cls).toContain(c);
    }
    // Never attached to the screen edges.
    expect(cls).not.toContain('bottom-0');
    expect(cls).not.toContain('inset-x-0');
    expect(cls).not.toContain('border-t');
  });

  it('the floating row carries the bottom anchor so Undo and selection bars stack above it', () => {
    const container = render('/pipeline');
    expect(nav(container).hasAttribute(BOTTOM_ANCHOR_ATTR)).toBe(true);
    expect(container.querySelectorAll(`[${BOTTOM_ANCHOR_ATTR}]`)).toHaveLength(1);
  });

  it('pill: 52 tall at rest, round, panel fill, flat hairline edge (no lit height, no shadow)', () => {
    const container = render('/pipeline');
    const pill = container.querySelector('[data-tab-pill]');
    if (pill === null) throw new Error('no pill');
    for (const c of [
      'flex',
      'shrink-0',
      'items-center',
      'rounded-full',
      'border',
      'border-border',
      'bg-panel',
      MOVE_CLASS.dock,
      'h-13',
      'px-1',
    ]) {
      expect(classes(pill)).toContain(c);
    }
    expect(classes(pill)).not.toContain('h-15');
    expect(classes(pill)).not.toContain('flex-1');
    expect(classes(pill).some((c) => c.startsWith('lit-'))).toBe(false);
    expect(classes(pill).some((c) => c.startsWith('shadow'))).toBe(false);
    const chat = classes(chatLink(container));
    expect(chat).toEqual(expect.arrayContaining(['border', 'border-border', 'bg-panel']));
    expect(chat).not.toContain('lit-raised');
    expect(chat).not.toContain('lit-pill');
    expect(chat.some((c) => c.startsWith('shadow'))).toBe(false);
  });

  it('only the active tab shows its label; the rest are icon only with an aria-label', () => {
    const container = render('/briefs');
    const links = pillLinks(container);
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Pipeline',
      'Briefs',
      'Assets',
      'Plan',
      'Activity',
    ]);
    expect(links.map((a) => a.textContent)).toEqual(['', 'Briefs', '', '', '']);
    const active = links[1];
    if (active === undefined) throw new Error('no Briefs tab');
    expect(classes(active)).toEqual(
      expect.arrayContaining(['bg-panel-3', 'text-fg', 'gap-2', 'px-3', MOVE_CLASS.dock]),
    );
    expect(active.getAttribute('data-selected')).toBe('true');
    for (const c of ['bg-accent', 'text-accent-fg', 'lit-pill', 'bg-accent-soft']) {
      expect(classes(active)).not.toContain(c);
    }
    const label = active.querySelector('span');
    expect(classes(label ?? active)).toEqual(
      expect.arrayContaining(['whitespace-nowrap', 'text-md', 'font-medium']),
    );
    expect(classes(label ?? active)).not.toContain('font-semibold');
    for (const idle of [links[0], links[2], links[3], links[4]]) {
      expect(classes(idle ?? active)).toContain('text-fg-2');
      expect(classes(idle ?? active)).toContain('w-11');
      expect(classes(idle ?? active)).not.toContain('text-fg');
      expect(classes(idle ?? active)).not.toContain('bg-panel-3');
      expect(classes(idle ?? active)).not.toContain('lit-active');
    }
  });

  it('Activity is active on /notifications with its label and aria-current', () => {
    const container = render('/notifications');
    const activity = container.querySelector('[data-activity-tab]');
    expect(activity?.textContent).toBe('Activity');
    expect(activity?.getAttribute('aria-current')).toBe('page');
    expect(pillLinks(container).filter((a) => (a.textContent ?? '') !== '')).toHaveLength(1);
  });

  it('every target is at least 44x44: pill tabs h-11 with w-11 or min-w-11, Chat 52x52 at rest', () => {
    const container = render('/pipeline');
    for (const a of pillLinks(container)) {
      const cls = classes(a);
      expect(cls).toContain('h-11');
      expect(cls).toContain('min-w-11');
    }
    const chat = classes(chatLink(container));
    expect(chat).toEqual(expect.arrayContaining(['h-13', 'w-13', 'rounded-full']));
    expect(chat).not.toContain('h-15');
  });

  it('Activity badge: the inbox unread count with the lit surface-top ring and the "Activity, N unread" name', () => {
    const container = render('/pipeline', 0, 4);
    const activity = container.querySelector('[data-activity-tab]');
    expect(activity?.getAttribute('aria-label')).toBe('Activity, 4 unread');
    const badge = activity?.querySelector('[data-count-badge]');
    expect(badge?.textContent).toBe('4');
    expect(classes(badge ?? document.body)).toEqual(
      expect.arrayContaining(['border-2', 'border-surface-top']),
    );
  });

  it('Chat badge: the chat unread count top-right and the "Chat, N unread" name', () => {
    expect(chatTabLabel(0)).toBe('Chat');
    expect(chatTabLabel(2)).toBe('Chat, 2 unread');
    const container = render('/pipeline', 2, 0);
    const chat = chatLink(container);
    expect(chat.getAttribute('aria-label')).toBe('Chat, 2 unread');
    const badge = chat.querySelector('[data-count-badge]');
    expect(badge?.textContent).toBe('2');
    expect(classes(badge ?? chat)).toEqual(
      expect.arrayContaining(['absolute', 'right-0', 'top-0', 'border-2', 'border-surface-top']),
    );
    expect(container.querySelector('[data-activity-tab] [data-count-badge]')).toBeNull();
  });

  it('no badges with nothing unread', () => {
    const container = render('/pipeline');
    expect(container.querySelectorAll('[data-count-badge]')).toHaveLength(0);
    expect(chatLink(container).getAttribute('aria-label')).toBe('Chat');
  });

  it('Chat circle: flat hairline panel at rest, the ink fill when active', () => {
    const idle = chatLink(render('/pipeline'));
    expect(classes(idle)).toEqual(
      expect.arrayContaining([
        'border-border',
        'bg-panel',
        'text-fg-2',
        'focus-visible:lit-focus',
        MOVE_CLASS.dock,
      ]),
    );
    expect(classes(idle)).not.toContain('bg-accent');
    expect(classes(idle)).not.toContain('lit-raised');
    act(() => root?.unmount());
    host?.remove();
    const active = chatLink(render('/chat'));
    // Opaque in every state: the ink fill replaces the panel fill.
    expect(classes(active)).toEqual(
      expect.arrayContaining(['bg-accent', 'text-accent-fg', 'border-transparent']),
    );
    expect(classes(active)).not.toContain('lit-pill');
    expect(classes(active)).not.toContain('bg-panel');
    expect(classes(active)).not.toContain('bg-accent-soft');
    expect(active.querySelector('[data-chat-tab-tint]')).toBeNull();
  });

  it('tour anchors: activityTab on the Activity tab, chatTab on the Chat circle, once each', () => {
    const container = render('/pipeline');
    const activity = container.querySelectorAll(`[data-induction="${INDUCTION_KEYS.activityTab}"]`);
    const chat = container.querySelectorAll(`[data-induction="${INDUCTION_KEYS.chatTab}"]`);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.hasAttribute('data-activity-tab')).toBe(true);
    expect(chat).toHaveLength(1);
    expect(chat[0]).toBe(chatLink(container));
  });

  it('long-press: no iOS callout or text selection on the bar', () => {
    const cls = classes(nav(render('/pipeline')));
    expect(cls).toContain('select-none');
    expect(cls).toContain('[-webkit-touch-callout:none]');
  });

  it('motion only through src/lib/motion: mv-dock on the bar, no raw transition, duration or animate classes', () => {
    const container = render('/briefs');
    expect(container.innerHTML).not.toMatch(/\b(transition|duration-|animate-)/);
    expect(MOVE_CLASS.dock).toBe('mv-dock');
    expect(classes(nav(container))).toContain(MOVE_CLASS.dock);
  });

  it('a non-interactive fade strip sits behind the bar in the bg token', () => {
    const container = render('/pipeline');
    const fade = container.querySelector('div[aria-hidden="true"]');
    if (fade === null) throw new Error('no fade');
    expect(classes(fade)).toEqual(
      expect.arrayContaining([
        'md:hidden',
        'pointer-events-none',
        'fixed',
        'bottom-0',
        'h-24',
        'bg-gradient-to-t',
        'from-bg',
        'to-bg/0',
      ]),
    );
    expect(fade.hasAttribute(BOTTOM_ANCHOR_ATTR)).toBe(false);
  });
});

describe('Plan tab unread comments badge', () => {
  it('shows the shared count pill on the Plan tab only when plan items have unread comments', () => {
    counts.plan = 3;
    const view = render('/pipeline');
    const plan = pillLinks(view).find((a) => a.getAttribute('href') === '/plan');
    expect(plan?.querySelector('[data-count-badge]')?.textContent).toBe('3');
    expect(plan?.getAttribute('aria-label')).toBe('Plan, 3 unread comments');
    const others = pillLinks(view).filter((a) => a.getAttribute('href') !== '/plan');
    for (const link of others) expect(link.querySelector('[data-count-badge]')).toBeNull();
  });

  it('with unread, the Plan tab opens the newest unread plan comment (jump to latest)', () => {
    counts.plan = 2;
    counts.newest = { planId: 'pl1', itemId: 'i1', commentId: 'c1' };
    const view = render('/pipeline');
    const plan = pillLinks(view).find((a) => a.getAttribute('aria-label')?.startsWith('Plan'));
    expect(plan?.getAttribute('href')).toBe('/plan/pl1?item=i1&comment=c1');
  });

  it('no unread: no badge and the plain label', () => {
    const view = render('/pipeline');
    const plan = pillLinks(view).find((a) => a.getAttribute('href') === '/plan');
    expect(plan?.querySelector('[data-count-badge]')).toBeNull();
    expect(plan?.getAttribute('aria-label')).toBe('Plan');
    expect(planTabLabel('Plan', 0)).toBe('Plan');
    expect(planTabLabel('Plan', 1)).toBe('Plan, 1 unread comment');
  });
});

describe('tabClass: the flat pill tab', () => {
  it('active at rest: the panel-3 fill in fg ink, label room (gap-2 px-3); never the ink fill', () => {
    const cls = tabClass(true).split(' ');
    expect(cls).toEqual(
      expect.arrayContaining(['h-11', 'min-w-11', 'rounded-full', 'bg-panel-3', 'text-fg']),
    );
    expect(cls).toEqual(expect.arrayContaining(['gap-2', 'px-3', MOVE_CLASS.dock]));
    expect(cls).not.toContain('w-11');
    for (const c of ['bg-accent', 'text-accent-fg', 'lit-pill', 'mv-tint']) {
      expect(cls).not.toContain(c);
    }
  });

  it('active while shrunk: the same fill, squeezed to the 44 circle (no label room)', () => {
    const cls = tabClass(true, true).split(' ');
    expect(cls).toEqual(expect.arrayContaining(['bg-panel-3', 'text-fg', 'w-11', MOVE_CLASS.dock]));
    expect(cls).not.toContain('px-3');
    expect(cls).not.toContain('gap-2');
  });

  it('inactive: the icon alone in fg-2 in a 44 box, shrunk or not', () => {
    for (const shrunk of [false, true]) {
      const cls = tabClass(false, shrunk).split(' ');
      expect(cls).toEqual(expect.arrayContaining(['h-11', 'w-11', 'text-fg-2', MOVE_CLASS.dock]));
      expect(cls).not.toContain('bg-panel-3');
      expect(cls).not.toContain('bg-accent');
      expect(cls).not.toContain('lit-pill');
    }
  });
});

describe('dockShrinkNext: one scroll step decides the dock (pure)', () => {
  it.each([
    // [shrunk, prevTop, top, next]
    // Near the top (<= 24) the dock always rests, whatever the step.
    [true, 0, 24, false],
    [true, 200, 10, false],
    [false, 0, 24, false],
    [true, 20, 24, false],
    [false, 0, 20, false],
    // A step down past 8 shrinks.
    [false, 100, 109, true],
    [false, 100, 300, true],
    [true, 100, 200, true],
    // A step up past 8 grows.
    [true, 300, 291, false],
    [true, 300, 100, false],
    [false, 300, 100, false],
    // A step of 8 or less either way keeps the state.
    [true, 100, 108, true],
    [false, 100, 108, false],
    [true, 100, 92, true],
    [false, 100, 92, false],
    [true, 100, 100, true],
    [false, 100, 100, false],
  ] as const)('shrunk=%s, %s -> %s gives %s', (shrunk, prevTop, top, next) => {
    expect(dockShrinkNext(shrunk, prevTop, top)).toBe(next);
  });
});

/** Sets el.scrollTop (jsdom keeps it 0) and fires one non-bubbling scroll on it. */
function scrollTo(el: HTMLElement, top: number): void {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
  act(() => {
    el.dispatchEvent(new Event('scroll'));
  });
}

describe('useDockShrunk: one passive capture scroll listener on document', () => {
  function Probe() {
    const shrunk = useDockShrunk();
    return <span data-probe={shrunk ? 'shrunk' : 'rest'} />;
  }

  function mountProbe(): HTMLDivElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Probe />));
    return host;
  }

  it('adds exactly one scroll listener ({capture, passive}) and removes the same one on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    try {
      mountProbe();
      const added = add.mock.calls.filter(([type]) => type === 'scroll');
      expect(added).toHaveLength(1);
      const handler = added[0]?.[1];
      expect(handler).toBeTypeOf('function');
      expect(added[0]?.[2]).toEqual({ capture: true, passive: true });
      expect(remove.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(0);
      act(() => root?.unmount());
      root = null;
      const removed = remove.mock.calls.filter(([type]) => type === 'scroll');
      expect(removed).toHaveLength(1);
      expect(removed[0]?.[1]).toBe(handler);
      expect(removed[0]?.[2]).toEqual({ capture: true, passive: true });
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('flips on an inner scroller: down shrinks, small steps keep, up grows, the top rests', () => {
    const view = mountProbe();
    const state = (): string | null =>
      view.querySelector('[data-probe]')?.getAttribute('data-probe') ?? null;
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    expect(state()).toBe('rest');
    scrollTo(scroller, 100); // first read: no step yet
    expect(state()).toBe('rest');
    scrollTo(scroller, 200); // down 100
    expect(state()).toBe('shrunk');
    scrollTo(scroller, 195); // up 5: kept
    expect(state()).toBe('shrunk');
    scrollTo(scroller, 150); // up 45
    expect(state()).toBe('rest');
    scrollTo(scroller, 300); // down 150
    expect(state()).toBe('shrunk');
    scrollTo(scroller, 10); // near the top
    expect(state()).toBe('rest');
    scroller.remove();
  });
});

describe('BottomTabs: the dock shrinks on scroll down', () => {
  it('rest: data-dock="rest", 52 pill and Chat circle, the active label shows', () => {
    const container = render('/briefs');
    const bar = nav(container);
    expect(bar.getAttribute('data-dock')).toBe('rest');
    expect(classes(bar)).not.toContain('translate-y-1');
    const pill = container.querySelector('[data-tab-pill]');
    expect(classes(pill ?? bar)).toEqual(expect.arrayContaining(['h-13', 'px-1']));
    expect(classes(chatLink(container))).toEqual(expect.arrayContaining(['h-13', 'w-13']));
    expect(pillLinks(container).map((a) => a.textContent)).toEqual(['', 'Briefs', '', '', '']);
  });

  it('shrunk: data-dock="shrunk", 44 pill and Chat circle, nudged down, labels hidden (icons stay)', () => {
    const container = render('/briefs');
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    scrollTo(scroller, 100);
    scrollTo(scroller, 300);
    const bar = nav(container);
    expect(bar.getAttribute('data-dock')).toBe('shrunk');
    expect(classes(bar)).toEqual(expect.arrayContaining(['translate-y-1', MOVE_CLASS.dock]));
    const pill = container.querySelector('[data-tab-pill]');
    expect(classes(pill ?? bar)).toContain('h-11');
    expect(classes(pill ?? bar)).not.toContain('h-13');
    const chat = classes(chatLink(container));
    expect(chat).toEqual(expect.arrayContaining(['h-11', 'w-11']));
    expect(chat).not.toContain('h-13');
    expect(pillLinks(container).map((a) => a.textContent)).toEqual(['', '', '', '', '']);
    // The icon stays on the active tab; only its label hides.
    expect(pillLinks(container)[1]?.querySelector('svg')).not.toBeNull();
    scroller.remove();
  });
});
