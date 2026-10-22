import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { boldMatches, highlightName, searchResultsView } from '@/components/chat/SearchResults';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  IDLE_SEARCH,
  SEARCH_EMPTY_COPY,
  SEARCH_FAILED_COPY,
  type SearchState,
} from '@/lib/chat/search';

function channel(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'g1',
    channelType: 'group',
    title: 'Shoot crew',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'grp1',
    peerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const group = channel({});
const dm = channel({ channelId: 'd1', channelType: 'dm', title: 'Priya Shah', groupId: null });
const byId = new Map([
  [group.channelId, group],
  [dm.channelId, dm],
]);
const nameOf = (id: string) => (id === 'u2' ? 'Priya Shah' : undefined);
const now = Date.parse('2026-10-03T15:00:00Z');

function view(state: SearchState, query = 'sho') {
  return renderToStaticMarkup(
    searchResultsView({
      query,
      chats: [group],
      state,
      channelsById: byId,
      currentUserId: 'me',
      nameOf,
      nowMs: now,
      timeZone: 'UTC',
      onOpenChat: () => {},
      onOpenHit: () => {},
      onRetry: () => {},
    }),
  );
}

const ready = (hits: SearchState['hits'], hasMore = false): SearchState => ({
  ...IDLE_SEARCH,
  query: 'sho',
  status: 'ready',
  hits,
  hasMore,
});

describe('searchResultsView', () => {
  it('shows Chats then Messages with bold matches and sender prefixes', () => {
    const html = view(
      ready([
        {
          id: 'm1',
          channelId: 'g1',
          senderUserId: 'u2',
          body: 'Shoot at 5',
          createdAt: '2026-10-03T09:00:00Z',
        },
        {
          id: 'm2',
          channelId: 'g1',
          senderUserId: 'me',
          body: 'the show',
          createdAt: '2026-09-20T09:00:00Z',
        },
        {
          id: 'm3',
          channelId: 'd1',
          senderUserId: 'u2',
          body: 'shoot?',
          createdAt: '2026-10-02T09:00:00Z',
        },
      ]),
    );
    expect(html.indexOf('data-section-label="chats"')).toBeLessThan(
      html.indexOf('data-section-label="messages"'),
    );
    expect(html).toContain('<span data-name-match="" class="text-accent">Sho</span>');
    expect(html).toContain('Priya: ');
    expect(html).toContain('You: ');
    expect(html).toContain('<b data-search-match="" class="font-semibold text-fg">Shoot</b>');
    expect(html).toContain('20/09/26');
    expect(html).toContain('Yesterday');
    // DM peer: no prefix before the snippet.
    expect(html).toMatch(
      /data-search-snippet=""[^>]*><b data-search-match="" class="font-semibold text-fg">shoot<\/b>/,
    );
    // Group: rounded square; person: circle.
    expect(html).toContain('[&amp;&gt;*]:!rounded-[12px]');
    // Long-press: no selection, no callout.
    expect(html).toContain('[-webkit-touch-callout:none]');
  });

  it('shows "No messages like that" when nothing matches', () => {
    expect(view(ready([]))).toContain(SEARCH_EMPTY_COPY);
  });

  it('shows the retry row on failure, never connection wording', () => {
    const html = view({ ...IDLE_SEARCH, query: 'sho', status: 'error' });
    expect(html).toContain('data-search-retry');
    expect(html).toContain(SEARCH_FAILED_COPY.slice(SEARCH_FAILED_COPY.indexOf('t ') + 2));
    expect(SEARCH_FAILED_COPY).toBe("Couldn't search. Try again.");
    expect(html.toLowerCase()).not.toMatch(/offline|network|connect/);
  });

  it('shows skeleton rows (never stale hits) while the latest query is out', () => {
    const stale = ready([
      {
        id: 'm1',
        channelId: 'g1',
        senderUserId: 'u2',
        body: 'shoot',
        createdAt: '2026-10-03T09:00:00Z',
      },
    ]);
    const html = view(stale, 'shoe');
    expect(html).toContain('data-search-skeleton');
    expect(html).not.toContain('data-search-hit');
  });

  it('a 101 character query reads "No messages like that"', () => {
    expect(view(IDLE_SEARCH, 'x'.repeat(101))).toContain(SEARCH_EMPTY_COPY);
  });

  it('keeps a scroll marker while more pages exist', () => {
    const html = view(
      ready(
        [
          {
            id: 'm1',
            channelId: 'g1',
            senderUserId: 'u2',
            body: 'shoot',
            createdAt: '2026-10-03T09:00:00Z',
          },
        ],
        true,
      ),
    );
    expect(html).toContain('data-search-sentinel');
  });

  it('renders mention tokens in snippets as names', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const html = view(
      ready([
        {
          id: 'm1',
          channelId: 'd1',
          senderUserId: 'u2',
          body: `@[${id}] shoot`,
          createdAt: '2026-10-03T09:00:00Z',
        },
      ]),
    );
    expect(html).not.toContain('@[');
    expect(html).toContain('@Former member');
  });
});

describe('highlight helpers', () => {
  it('highlightName accents the matched part of a name', () => {
    expect(renderToStaticMarkup(<>{highlightName('Priya Shah', 'sha')}</>)).toBe(
      'Priya <span data-name-match="" class="text-accent">Sha</span>h',
    );
  });
  it('boldMatches bolds a Devanagari prefix match', () => {
    expect(renderToStaticMarkup(<>{boldMatches('कल नमस्ते', ['नम'])}</>)).toContain(
      '<b data-search-match="" class="font-semibold text-fg">नमस्ते</b>',
    );
  });
});
