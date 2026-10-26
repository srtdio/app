// Chat visual pass (24 Oct audit): readability and consistency fixes across
// the list, the thread, the drawer and contact info. Source checks where the
// piece is buried in a hook-heavy component; rendered markup where it is not.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { searchChips, TILE_TIME_ROW, TILE_TIME_TYPE } from '@/components/chat/ChannelList';
import { QUICK_REACTIONS } from '@/components/chat/MessageActionMenu';
import { mentionClass, OWN_BUBBLE_CONTENT } from '@/components/chat/MessageThread';
import { holdTipView } from '@/components/chat/ThreadHoldTip';
import { DATE_PILL_TYPE } from '@/components/chat/chat-type';
import { SEARCH_MARK_CLASS } from '@/components/ui/SearchHighlight';
import { HOLD_TIP_TEXT, HOLD_TIP_TEXT_LAPTOP } from '@/lib/chat/thread-tip';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('chat visual pass', () => {
  it('own-bubble cards remap the panel-2 fill, so the stage tag reads on indigo', () => {
    expect(OWN_BUBBLE_CONTENT).toContain('[&_.bg-panel-2]:bg-black/[.12]');
  });

  it('times and dates are mono: bubble time, day pill, list time', () => {
    expect(read('../MessageThread.tsx')).toMatch(
      /<span aria-hidden="true" className="font-mono">\s*\{meta\.time\}/,
    );
    expect(DATE_PILL_TYPE.touch).toContain('font-mono');
    expect(DATE_PILL_TYPE.laptop).toContain('font-mono');
    expect(TILE_TIME_TYPE).toContain('font-mono');
    expect(TILE_TIME_TYPE).not.toContain('font-sans');
  });

  it('a mention never breaks across lines, and the own-name tint has room', () => {
    expect(mentionClass(false, true)).toContain('whitespace-nowrap');
    expect(mentionClass(false, true)).toContain('px-[3px]');
    expect(mentionClass(true, false)).toContain('whitespace-nowrap');
  });

  it('the in-review drawer dims with the sheet scrim, not the lightbox overlay', () => {
    const drawer = read('../StatusDrawer.tsx');
    expect(drawer).toContain('<Backdrop');
    expect(drawer).not.toContain('bg-overlay');
    expect(read('../../ui/Backdrop.tsx')).toContain('bg-scrim');
  });

  it('the list column is 352px from 1280px (288px below, so the plan panel never covers it) and a tile time stays clear of the ⋯', () => {
    expect(read('../ChatConnected.tsx')).toContain('md:w-72 md:border-r xl:w-[352px]');
    expect(read('../ChannelList.tsx')).toContain('data-tile-time="" className={TILE_TIME_ROW}');
    expect(TILE_TIME_ROW).toContain('pr-11');
  });

  it('filter chips fade at the trailing edge so a clipped chip reads as more', () => {
    const html = renderToStaticMarkup(searchChips({ kind: null, onChange: () => undefined }));
    expect(html).toContain(
      '[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)]',
    );
    expect(html).toContain('pr-10');
  });

  it('the list search is "Search chats", placeholder and name', () => {
    const list = read('../ChannelList.tsx');
    expect(list).toContain("placeholder: 'Search chats',");
    expect(list).toContain("label: 'Search chats',");
    expect(read('../../shell/SectionHeader.tsx')).toContain("'aria-label': search.label");
  });

  it('the hold tip names right-click on laptop and waits for a first message', () => {
    const touch = renderToStaticMarkup(holdTipView(() => undefined));
    const laptop = renderToStaticMarkup(holdTipView(() => undefined, 'laptop'));
    expect(touch).toContain(HOLD_TIP_TEXT);
    expect(laptop).toContain(HOLD_TIP_TEXT_LAPTOP);
    expect(HOLD_TIP_TEXT_LAPTOP).toBe('Tip: right-click a message to reply, copy or delete.');
    expect(HOLD_TIP_TEXT_LAPTOP).not.toContain('—');
    expect(read('../MessageThread.tsx')).toMatch(
      /<ThreadHoldTip\s+userId=\{props\.currentUserId \?\? ''\}\s+layout=\{layout\}\s+empty=\{props\.messages\.length === 0\}/,
    );
    const tip = read('../ThreadHoldTip.tsx');
    expect(tip).toContain('if (show && !empty) noteHoldTipShown(userId);');
    expect(tip).toContain('if (!show || empty) return null;');
  });

  it('contact info uses the same avatar fill as the list and header', () => {
    const sheet = read('../ContactSheet.tsx');
    expect(sheet).toContain('<Avatar');
    expect(sheet).toContain('role="profile"');
    expect(sheet).not.toContain('rounded-full bg-panel-3 text-2xl font-semibold text-fg-2');
  });

  it('info tabs stay on one row', () => {
    const tabs = read('../ChatInfoTabs.tsx');
    expect(tabs).toContain('flex flex-nowrap gap-1.5 overflow-x-auto');
    expect(tabs).not.toContain('<div className="flex flex-wrap gap-2" role="tablist">');
  });

  it('quick reactions are all pictures', () => {
    expect([...QUICK_REACTIONS]).toContain('👌');
    expect([...QUICK_REACTIONS]).not.toContain('🆗');
  });

  it('search marks use their own fill and ink tokens, defined for both themes', () => {
    expect(SEARCH_MARK_CLASS).toContain('bg-search-mark');
    expect(SEARCH_MARK_CLASS).toContain('[color:var(--search-mark-fg)]');
    const css = read('../../../index.css');
    expect(css.match(/--search-mark-bg:/g)).toHaveLength(2);
    expect(css.match(/--search-mark-fg:/g)).toHaveLength(2);
  });
});
