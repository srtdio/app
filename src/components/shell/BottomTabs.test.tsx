// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({ chat: 0, inbox: 0 }));

vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ state: {} }),
}));
vi.mock('@/lib/chat/chat-store', () => ({ selectTotalUnread: () => counts.chat }));
vi.mock('@/components/shell/InboxStoreProvider', () => ({
  useInboxStore: () => ({ unreadCount: counts.inbox }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { BottomTabs, PHONE_BAR_OFFSETS, chatTabLabel } from '@/components/shell/BottomTabs';
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

  it('guard: the row floats 12px from the sides and the bottom, phone only', () => {
    expect(PHONE_BAR_OFFSETS).toBe(
      'left-3 right-3 bottom-[calc(12px+env(safe-area-inset-bottom))]',
    );
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

  it('pill: 60 tall, round, panel fill, border and the card shadow token', () => {
    const container = render('/pipeline');
    const pill = container.querySelector('[data-tab-pill]');
    if (pill === null) throw new Error('no pill');
    for (const c of [
      'h-[60px]',
      'rounded-full',
      'bg-panel',
      'border',
      'border-border',
      'p-1',
      'shadow-[var(--shadow-card)]',
    ]) {
      expect(classes(pill)).toContain(c);
    }
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
    expect(classes(active)).toEqual(expect.arrayContaining(['bg-accent-soft', 'text-accent']));
    const label = active.querySelector('span');
    expect(classes(label ?? active)).toEqual(
      expect.arrayContaining(['whitespace-nowrap', 'text-md', 'font-semibold']),
    );
    for (const idle of [links[0], links[2], links[3], links[4]]) {
      expect(classes(idle ?? active)).toContain('text-fg-2');
    }
  });

  it('Activity is active on /notifications with its label and aria-current', () => {
    const container = render('/notifications');
    const activity = container.querySelector('[data-activity-tab]');
    expect(activity?.textContent).toBe('Activity');
    expect(activity?.getAttribute('aria-current')).toBe('page');
    expect(pillLinks(container).filter((a) => (a.textContent ?? '') !== '')).toHaveLength(1);
  });

  it('every target is at least 44x44: pill tabs h-11 with w-11 or min-w-[44px], Chat 60x60', () => {
    const container = render('/pipeline');
    for (const a of pillLinks(container)) {
      const cls = classes(a);
      expect(cls).toContain('h-11');
      expect(cls).toContain('min-w-[44px]');
    }
    const chat = classes(chatLink(container));
    expect(chat).toEqual(expect.arrayContaining(['h-[60px]', 'w-[60px]', 'rounded-full']));
  });

  it('Activity badge: the inbox unread count with the panel ring and the "Activity, N unread" name', () => {
    const container = render('/pipeline', 0, 4);
    const activity = container.querySelector('[data-activity-tab]');
    expect(activity?.getAttribute('aria-label')).toBe('Activity, 4 unread');
    const badge = activity?.querySelector('[data-count-badge]');
    expect(badge?.textContent).toBe('4');
    expect(classes(badge ?? document.body)).toEqual(
      expect.arrayContaining(['border-2', 'border-panel']),
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
      expect.arrayContaining(['absolute', 'right-0', 'top-0', 'border-2', 'border-panel']),
    );
    expect(container.querySelector('[data-activity-tab] [data-count-badge]')).toBeNull();
  });

  it('no badges with nothing unread', () => {
    const container = render('/pipeline');
    expect(container.querySelectorAll('[data-count-badge]')).toHaveLength(0);
    expect(chatLink(container).getAttribute('aria-label')).toBe('Chat');
  });

  it('Chat circle: fg ink at rest, accent ink and accent-soft fill when active', () => {
    expect(classes(chatLink(render('/pipeline')))).toEqual(
      expect.arrayContaining(['bg-panel', 'text-fg']),
    );
    act(() => root?.unmount());
    host?.remove();
    expect(classes(chatLink(render('/chat')))).toEqual(
      expect.arrayContaining(['bg-accent-soft', 'text-accent']),
    );
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

  it('no motion: no transition, duration or animate classes anywhere in the bar', () => {
    const container = render('/briefs');
    expect(container.innerHTML).not.toMatch(/\b(transition|duration-|animate-)/);
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
        'h-[120px]',
        'bg-gradient-to-t',
        'from-bg',
        'to-bg/0',
      ]),
    );
    expect(fade.hasAttribute(BOTTOM_ANCHOR_ATTR)).toBe(false);
  });
});
