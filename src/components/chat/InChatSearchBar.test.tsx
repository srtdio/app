import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  closeInChatSearch,
  highlightWords,
  inChatCounter,
  InChatSearchBar,
} from '@/components/chat/InChatSearchBar';
import { renderBodyWithMentions } from '@/components/chat/MessageThread';
import { IDLE_SEARCH, type SearchState } from '@/lib/chat/search';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const hits = ['m3', 'm2', 'm1'].map((id) => ({
  id,
  channelId: 'c1',
  senderUserId: 'u2',
  body: 'shoot',
  createdAt: '2026-10-03T09:00:00Z',
}));
const ready = (hasMore: boolean): SearchState => ({
  ...IDLE_SEARCH,
  query: 'shoot',
  status: 'ready',
  hits,
  hasMore,
});

describe('InChatSearchBar', () => {
  it('renders close, the input, the counter slot and both arrows (44px)', () => {
    const html = renderToStaticMarkup(
      <InChatSearchBar
        workspaceId="w1"
        channelId="c1"
        initialQuery="shoot"
        anchorMessageId="m2"
        onJump={() => {}}
        onTermsChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Close search"');
    expect(html).toContain('value="shoot"');
    expect(html).toContain('aria-label="Older match"');
    expect(html).toContain('aria-label="Newer match"');
    expect(html).toContain('font-mono');
    expect(html).toContain('h-11 w-11');
  });

  it('counter reads "N of M", with "+" while more pages exist', () => {
    expect(inChatCounter(ready(false), 'shoot', 0)).toBe('1 of 3');
    expect(inChatCounter(ready(true), 'shoot', 1)).toBe('2 of 3+');
    // A query whose answer is not in yet shows no counter.
    expect(inChatCounter(ready(false), 'shoe', 0)).toBeNull();
  });

  it('close disposes the search, clears every highlight, then closes', () => {
    const order: string[] = [];
    const words: Array<readonly string[]> = [];
    closeInChatSearch({
      runner: { dispose: () => order.push('dispose') },
      onTermsChange: (w) => {
        order.push('terms');
        words.push(w);
      },
      onClose: () => order.push('close'),
    });
    expect(order).toEqual(['dispose', 'terms', 'close']);
    expect(words).toEqual([[]]);
  });

  it('bubbles mark matched words while open, none once the words clear', () => {
    const ctx = { nameOf: () => undefined, viewerUserId: 'me' };
    const open = renderToStaticMarkup(
      <p>
        {renderBodyWithMentions('Shoot at 5', false, { ...ctx, highlight: highlightWords('sho') })}
      </p>,
    );
    expect(open).toContain('<mark data-search-mark=""');
    expect(open).toContain('bg-search-mark');
    expect(open).toContain('>Shoot</mark>');
    const closed = renderToStaticMarkup(
      <p>{renderBodyWithMentions('Shoot at 5', false, { ...ctx, highlight: [] })}</p>,
    );
    expect(closed).not.toContain('<mark');
    expect(highlightWords('s')).toEqual([]);
  });
});
