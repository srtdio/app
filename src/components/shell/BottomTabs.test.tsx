// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  tabClass,
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

  it('only the open tab shows its name: panel-3 fill, icon + name; the others are 44 icon slots', () => {
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
      expect.arrayContaining([
        'h-11',
        'min-w-11',
        'gap-2',
        'px-3',
        'bg-panel-3',
        'text-fg',
        MOVE_CLASS.dock,
      ]),
    );
    expect(classes(active)).not.toContain('w-11');
    expect(active.getAttribute('data-selected')).toBe('true');
    expect(active.querySelector('svg')).not.toBeNull();
    expect(classes(active.querySelector('[data-tab-name]') ?? active)).toEqual(
      expect.arrayContaining(['shrink-0', 'whitespace-nowrap', 'text-md', 'font-medium']),
    );
    for (const c of ['bg-accent', 'text-accent-fg', 'lit-pill', 'bg-accent-soft']) {
      expect(classes(active)).not.toContain(c);
    }
    for (const idle of [links[0], links[2], links[3], links[4]]) {
      expect(classes(idle ?? active)).toEqual(
        expect.arrayContaining(['h-11', 'w-11', 'text-fg-2']),
      );
      expect(classes(idle ?? active)).not.toContain('text-fg');
      expect(classes(idle ?? active)).not.toContain('bg-panel-3');
      expect(classes(idle ?? active)).not.toContain('px-3');
      expect((idle ?? active).querySelector('[data-tab-name]')).toBeNull();
    }
  });

  it('Activity is active on /notifications: the fill, aria-current and its name; the icon centres', () => {
    const container = render('/notifications');
    const activity = container.querySelector('[data-activity-tab]');
    expect(activity?.textContent).toBe('Activity');
    expect(activity?.getAttribute('aria-label')).toBe('Activity');
    expect(activity?.getAttribute('aria-current')).toBe('page');
    expect(classes(activity ?? container)).toEqual(
      expect.arrayContaining(['bg-panel-3', 'min-w-11', 'gap-2', 'px-3']),
    );
    // The icon wrapper is inline-flex, so the icon centres like the other four.
    const wrapper = activity?.firstElementChild;
    expect(classes(wrapper ?? container)).toEqual(
      expect.arrayContaining(['relative', 'inline-flex']),
    );
    expect(wrapper?.querySelector('svg')).not.toBeNull();
  });

  it('one name in the pill at a time on every route, each from the nav; Chat names itself on /chat', () => {
    const names: Record<string, string> = {
      '/pipeline': 'Pipeline',
      '/briefs': 'Briefs',
      '/assets': 'Assets',
      '/plan': 'Plan',
      '/notifications': 'Activity',
    };
    for (const [route, name] of Object.entries(names)) {
      const container = render(route);
      const shown = Array.from(container.querySelectorAll('[data-tab-pill] [data-tab-name]'));
      expect(shown.map((n) => n.textContent)).toEqual([name]);
      expect(shown[0]?.closest('a')?.getAttribute('data-selected')).toBe('true');
      // Chat away from /chat: the 52 circle, icon only.
      const chat = chatLink(container);
      expect(classes(chat)).toEqual(expect.arrayContaining(['h-13', 'w-13', 'rounded-full']));
      expect(chat.querySelector('[data-tab-name]')).toBeNull();
      act(() => root?.unmount());
      container.remove();
    }
    const container = render('/chat');
    expect(container.querySelectorAll('[data-tab-pill] [data-tab-name]')).toHaveLength(0);
    for (const a of pillLinks(container)) expect(classes(a)).toContain('w-11');
    const chat = chatLink(container);
    expect(chat.textContent).toBe(PRIMARY_NAV.find((i) => i.showChatBadge === true)?.label);
    expect(classes(chat)).toEqual(
      expect.arrayContaining(['h-13', 'gap-2', 'px-4', 'bg-accent', 'text-accent-fg']),
    );
    expect(classes(chat)).not.toContain('w-13');
    expect(classes(chat)).not.toContain('h-15');
    expect(classes(chat.querySelector('[data-tab-name]') ?? chat)).toEqual(
      expect.arrayContaining(['whitespace-nowrap', 'text-md', 'font-medium']),
    );
    expect(chat.querySelector('svg')).not.toBeNull();
  });

  it('badge ring: panel-3 on the open tab (its fill), surface-top on the others', () => {
    const onPipeline = render('/pipeline', 0, 4);
    const ring = (view: HTMLElement, sel: string): string[] =>
      classes(view.querySelector(`${sel} [data-count-badge]`) ?? view);
    expect(ring(onPipeline, '[data-activity-tab]')).toContain('border-surface-top');
    expect(ring(onPipeline, '[data-activity-tab]')).not.toContain('border-panel-3');
    act(() => root?.unmount());
    onPipeline.remove();
    const onActivity = render('/notifications', 0, 4);
    expect(ring(onActivity, '[data-activity-tab]')).toEqual(
      expect.arrayContaining(['border-2', 'border-panel-3']),
    );
    expect(ring(onActivity, '[data-activity-tab]')).not.toContain('border-surface-top');
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

describe('nav numbers: only Activity and Chat (13 Nov 2026)', () => {
  it('the Plan tab carries no badge, plain label and plain /plan link, even with unread plan comments', () => {
    counts.plan = 3;
    counts.newest = { planId: 'pl1', itemId: 'i1', commentId: 'c1' };
    const view = render('/pipeline', 2, 4);
    const plan = pillLinks(view).find((a) => a.getAttribute('aria-label') === 'Plan');
    expect(plan?.getAttribute('href')).toBe('/plan');
    expect(plan?.querySelector('[data-count-badge]')).toBeNull();
    // Pipeline, Briefs, Assets, Plan: no number at all.
    for (const link of pillLinks(view).filter((a) => !a.hasAttribute('data-activity-tab'))) {
      expect(link.querySelector('[data-count-badge]')).toBeNull();
    }
  });

  it('Activity and Chat keep their numbers', () => {
    const view = render('/pipeline', 2, 4);
    expect(view.querySelector('[data-activity-tab] [data-count-badge]')?.textContent).toBe('4');
    expect(view.querySelectorAll('[data-count-badge]').length).toBe(2);
  });
});

describe('tabClass: the flat pill tab', () => {
  it('active at rest: the panel-3 fill in fg ink with room for the name; never the ink fill', () => {
    const cls = tabClass(true).split(' ');
    expect(cls).toEqual(
      expect.arrayContaining([
        'h-11',
        'min-w-11',
        'gap-2',
        'px-3',
        'rounded-full',
        'bg-panel-3',
        'text-fg',
      ]),
    );
    for (const c of ['w-11', 'bg-accent', 'text-accent-fg', 'lit-pill']) {
      expect(cls).not.toContain(c);
    }
  });

  it('inactive: the icon alone in fg-2 in the 44 box', () => {
    const cls = tabClass(false).split(' ');
    expect(cls).toEqual(expect.arrayContaining(['h-11', 'w-11', 'text-fg-2']));
    for (const c of ['px-3', 'gap-2', 'bg-panel-3', 'bg-accent', 'lit-pill']) {
      expect(cls).not.toContain(c);
    }
  });
});

const source = readFileSync(join(process.cwd(), 'src/components/shell/BottomTabs.tsx'), 'utf8');

describe('BottomTabs: the nav never reacts to scroll (guard)', () => {
  it('source has no scroll listener, no useDockShrunk, no data-dock, no translate-y-1', () => {
    expect(source).not.toMatch(/addEventListener\(\s*['"]scroll['"]/);
    expect(source).not.toMatch(/['"]scroll['"]/);
    expect(source).not.toContain('useDockShrunk');
    expect(source).not.toContain('data-dock');
    expect(source).not.toContain('translate-y-1');
  });

  function snapshot(container: HTMLElement): string[] {
    const tabs = [...pillLinks(container), chatLink(container)];
    return [
      nav(container).getAttribute('class') ?? '',
      container.querySelector('[data-tab-pill]')?.getAttribute('class') ?? '',
      ...tabs.map((a) => a.getAttribute('class') ?? ''),
      ...Array.from(container.querySelectorAll('[data-tab-name]')).map((n) => n.textContent ?? ''),
    ];
  }

  function scrollTo(el: Element, top: number): void {
    Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
  }

  it.each(['/briefs', '/chat', '/notifications'])(
    'on %s: scrolling the document or an inner scroller changes nothing',
    (path) => {
      const container = render(path);
      const before = snapshot(container);
      expect(container.querySelectorAll('[data-tab-name]')).toHaveLength(1);
      const scroller = document.createElement('div');
      document.body.appendChild(scroller);
      const page = document.scrollingElement ?? document.documentElement;
      for (const top of [100, 300, 600, 250, 10, 0]) {
        scrollTo(page, top);
        act(() => {
          document.dispatchEvent(new Event('scroll'));
        });
        scrollTo(scroller, top);
        expect(snapshot(container)).toEqual(before);
      }
      scroller.remove();
      scrollTo(page, 0);
    },
  );

  it('rest look: 52 pill, Chat 52 circle, the open tab named, no dock attribute', () => {
    const container = render('/briefs');
    const bar = nav(container);
    expect(bar.hasAttribute('data-dock')).toBe(false);
    expect(classes(bar)).toContain(MOVE_CLASS.dock);
    expect(classes(bar)).not.toContain('translate-y-1');
    const pill = container.querySelector('[data-tab-pill]');
    expect(classes(pill ?? bar)).toEqual(expect.arrayContaining(['h-13', 'px-1']));
    expect(classes(chatLink(container))).toEqual(expect.arrayContaining(['h-13', 'w-13']));
    expect(pillLinks(container).map((a) => a.textContent)).toEqual(['', 'Briefs', '', '', '']);
  });
});
