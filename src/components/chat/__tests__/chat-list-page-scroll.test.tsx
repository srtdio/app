// The chat list scrolls the document on a phone (page mode,
// src/lib/scroll-mode.ts): the list pane, the list column and its body grow
// with the rows, the header row pins below the sticky Topbar and the select
// bar above the tab bar. Laptop and touch tablet (two panes) keep the
// full-height pane with its own scroller, class for class. Only position
// changes: colours, borders, spacing and lighting are the same in both.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// ChannelList and ChatConnected import the chat store, whose provider graph
// pulls the agora-chat browser SDK. Mock it so the pure helpers import cleanly.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { channelListClasses } from '@/components/chat/ChannelList';
import { chatListPageScroll, chatListPaneClass } from '@/components/chat/ChatConnected';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const classes = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

describe('chatListPageScroll: the phone list alone on screen', () => {
  it.each([
    // isDesktop, showList, showThread, page
    [false, true, false, true],
    [false, false, true, false],
    [false, true, true, false],
    [true, true, true, false],
    [true, true, false, false],
  ] as const)('desktop=%s list=%s thread=%s -> %s', (desktop, list, thread, page) => {
    expect(chatListPageScroll(desktop, list, thread)).toBe(page);
  });
});

describe('chatListPaneClass', () => {
  it('locked (default) is the full-height pane as before', () => {
    expect(chatListPaneClass(false)).toBe(
      'h-full w-full border-border md:w-72 md:border-r xl:w-chat-list',
    );
    expect(chatListPaneClass(false, false)).toBe(chatListPaneClass(false));
  });

  it('page scroll: the pane grows with the list (no full height)', () => {
    const page = classes(chatListPaneClass(false, true));
    expect(page).toContain('w-full');
    expect(page).not.toContain('h-full');
  });
});

describe('channelListClasses', () => {
  it('locked: the old full-height column whose body scrolls itself', () => {
    expect(channelListClasses(false)).toEqual({
      column: 'flex h-full flex-col',
      header: '',
      body: 'min-h-0 flex-1 overflow-y-auto',
      selectBar: '',
    });
  });

  it('page scroll: nothing scrolls inside, the document does', () => {
    const page = channelListClasses(true);
    expect(classes(page.column)).not.toContain('h-full');
    expect(classes(page.body)).not.toContain('overflow-y-auto');
    expect(classes(page.body)).not.toContain('min-h-0');
  });

  it('page scroll: the header pins below the sticky Topbar on the same page background', () => {
    const header = classes(channelListClasses(true).header);
    expect(header).toEqual(
      expect.arrayContaining(['sticky', 'z-sticky', 'bg-bg', SHELL_STICKY_TOP_CLASS]),
    );
    // No new lighting or border: the row keeps its own border-b and no lit-*.
    expect(header.some((c) => c.startsWith('lit-') || c.startsWith('shadow'))).toBe(false);
    expect(header.some((c) => c.startsWith('border'))).toBe(false);
  });

  it('page scroll: the select bar pins above the tab bar room <main> keeps', () => {
    const bar = classes(channelListClasses(true).selectBar);
    expect(bar).toEqual(
      expect.arrayContaining([
        'sticky',
        'z-sticky',
        'bottom-[calc(84px+env(safe-area-inset-bottom))]',
      ]),
    );
    // The same room AppLayout's shellChrome leaves for BottomTabs.
    expect(read('../../shell/AppLayout.tsx')).toContain(
      'pb-[calc(84px+env(safe-area-inset-bottom))]',
    );
  });
});

describe('wiring', () => {
  const src = read('../ChatConnected.tsx');

  it('the list gets the page-scroll flag and its pane class from one value', () => {
    expect(src).toContain(
      'const listPageScroll = chatListPageScroll(isDesktop, showList, showThread);',
    );
    expect(src).toContain('pageScroll={listPageScroll}');
  });

  it('the list opens at the top in a layout effect (first frame), and leaves the document at 0', () => {
    expect(src).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!listPageScroll\) return;\s*resetDocumentScroll\(\);\s*return resetDocumentScroll;\s*\}, \[listPageScroll\]\);/,
    );
  });

  it('the thread pane keeps its full height (the thread stays in the locked shell)', () => {
    expect(src).toContain("'relative h-full min-w-0 flex-1',");
  });
});
