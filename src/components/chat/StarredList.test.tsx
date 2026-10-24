import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ToastProvider } from '@/components/ui/toast';
import {
  sendersToRead,
  starredCanPage,
  starredListView,
  StarredEmpty,
  StarredList,
  StarredRowView,
  STARRED_LOADING,
  type StarredFeed,
  type StarredListViewProps,
} from '@/components/chat/StarredList';
import {
  createStarStore,
  EMPTY_STARS,
  StarStoreContext,
  STARRED_EMPTY_LINE,
  STARRED_EMPTY_TITLE,
  type StarredRow,
} from '@/lib/chat/stars';

function row(id: string, extra: Partial<StarredRow> = {}): StarredRow {
  return {
    id,
    channelId: 'c1',
    senderUserId: 'u2',
    body: `body ${id}`,
    createdAt: '2026-10-01T10:00:00Z',
    mediaLine: '',
    ...extra,
  };
}

function ready(rows: StarredRow[], next: StarredFeed['next'] = null): StarredFeed {
  return { status: 'ready', rows, next, loadingMore: false, moreFailed: false };
}

function viewProps(over: Partial<StarredListViewProps> = {}): StarredListViewProps {
  return {
    listId: 'c1',
    available: true,
    feed: ready([row('a'), row('b')]),
    snapshot: EMPTY_STARS,
    rowProps: (r) => ({
      sender: r.senderUserId === 'u1' ? 'You' : 'Chitra',
      chat: null,
      avatarUrl: null,
      mine: r.senderUserId === 'u1',
      date: '3:40 PM',
      text: r.body,
    }),
    editing: false,
    selected: new Set(),
    onToggle: () => undefined,
    onOpen: () => undefined,
    busy: false,
    onUnstar: () => undefined,
    onRetry: () => undefined,
    ...over,
  };
}

const html = (el: ReactElement): string =>
  renderToStaticMarkup(createElement(ToastProvider, null, el));

// Theme tokens straight from src/index.css; the hex sign is built from its
// char code and values print as rgb() so this chat file stays hash-free.
const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');
const HASH = String.fromCharCode(35);
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  const out = new Map<string, string>();
  const pattern = new RegExp(`--([\\w-]+):\\s*${HASH}([0-9a-f]{6});`, 'gi');
  for (const m of body.matchAll(pattern)) {
    const hex = m[2] ?? '';
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    out.set(m[1] ?? '', `rgb(${r ?? 0}, ${g ?? 0}, ${b ?? 0})`);
  }
  return out;
}
/** The colour tokens a tree's classes use, resolved in light and in dark. */
function themed(markup: string): Record<string, Record<string, string>> {
  const names = new Set<string>();
  for (const m of markup.matchAll(/\b(?:bg|text|border)-([a-z][\w-]*)/g)) names.add(m[1] ?? '');
  const out: Record<string, Record<string, string>> = { light: {}, ['dark']: {} };
  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    const map = tokens(selector);
    for (const name of [...names].sort()) {
      const value = map.get(name);
      if (value !== undefined) (out[theme] as Record<string, string>)[name] = value;
    }
  }
  return out;
}

describe('StarredRowView', () => {
  const base = {
    row: row('a'),
    sender: 'Chitra',
    chat: 'Diwali shoot',
    avatarUrl: null,
    mine: false,
    date: '3:40 PM',
    text: 'Moved the shoot to Monday',
    onOpen: () => undefined,
  };

  it('a 16px panel card: 28px avatar, Sender › Chat, mono date, chevron, peer bubble on panel-2', () => {
    const out = html(<ul>{StarredRowView(base)}</ul>);
    expect(out).toContain('rounded-[16px] border border-border bg-panel');
    expect(out).toContain('h-7 w-7');
    expect(out).toContain('Chitra');
    expect(out).toContain('›  Diwali shoot');
    expect(out).toContain('font-mono text-legacy-xs tabular-nums text-fg-3');
    expect(out).toContain('data-starred-bubble="peer"');
    expect(out).toContain('bg-panel-2 text-fg');
    expect(out).toContain('line-clamp-3');
    // No iOS callout, no text selection; at least 44px tall.
    expect(out).toContain('select-none [-webkit-touch-callout:none]');
    expect(out).toContain('min-h-[44px]');
  });

  it('chat home (fullText): a 600-char body renders whole, no clamp, no ellipsis', () => {
    const long = `${'Line one of the brief.\n'}${'word '.repeat(110)}https://example.com/${'a'.repeat(60)} END`;
    expect(long.length).toBeGreaterThanOrEqual(600);
    const out = html(<ul>{StarredRowView({ ...base, text: long, fullText: true })}</ul>);
    expect(out).toContain(long);
    expect(out).not.toMatch(/line-clamp|max-h-|text-ellipsis|\u2026|\.\.\./);
    const bubble = /<span data-starred-bubble="peer" class="([^"]*)"/.exec(out)?.[1] ?? '';
    expect(bubble).toContain('whitespace-pre-wrap');
    expect(bubble).toContain('[overflow-wrap:anywhere]');
    expect(bubble).not.toMatch(/line-clamp|max-h|overflow-hidden|truncate|\bh-\d/);
  });

  it('the per-chat lists keep the 3-line clamp', () => {
    const out = html(<ul>{StarredRowView({ ...base, fullText: false })}</ul>);
    expect(out).toContain('line-clamp-3 break-words');
  });

  it('own messages sit on the accent fill; no chat part draws none', () => {
    const out = html(<ul>{StarredRowView({ ...base, mine: true, chat: null, sender: 'You' })}</ul>);
    expect(out).toContain('data-starred-bubble="own"');
    expect(out).toContain('bg-bubble-own text-accent-fg');
    expect(out).not.toContain('data-starred-chat');
  });

  it('edit mode: a select circle, tap toggles instead of opening', () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const el = StarredRowView({ ...base, onOpen, selecting: { checked: true, onToggle } });
    const out = html(<ul>{el}</ul>);
    expect(out).toContain('data-select-check="on"');
    expect(out).toContain('aria-pressed="true"');
    const button = (el.props as { children: ReactElement<{ onClick: () => void }> }).children;
    button.props.onClick();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('light and dark snapshot (tokens only)', () => {
    const out = html(<ul>{StarredRowView(base)}</ul>);
    expect(out).not.toContain(`${'dark'}:`);
    expect(themed(out)).toMatchInlineSnapshot(`
      {
        "dark": {
          "border": "rgb(35, 38, 44)",
          "fg": "rgb(244, 245, 246)",
          "fg-2": "rgb(154, 160, 168)",
          "fg-3": "rgb(107, 113, 120)",
          "panel": "rgb(20, 21, 25)",
          "panel-2": "rgb(26, 28, 33)",
          "panel-3": "rgb(33, 35, 41)",
        },
        "light": {
          "border": "rgb(230, 232, 235)",
          "fg": "rgb(27, 28, 32)",
          "fg-2": "rgb(98, 102, 109)",
          "fg-3": "rgb(139, 144, 150)",
          "panel": "rgb(255, 255, 255)",
          "panel-2": "rgb(242, 243, 245)",
          "panel-3": "rgb(236, 237, 240)",
        },
      }
    `);
  });
});

describe('starredListView', () => {
  it('empty state: the title and one line, no illustration', () => {
    const out = html(starredListView(viewProps({ feed: ready([]) })));
    expect(out).toContain(STARRED_EMPTY_TITLE);
    expect(out).toContain(STARRED_EMPTY_LINE);
    expect(STARRED_EMPTY_TITLE).toBe('No starred messages');
    expect(STARRED_EMPTY_LINE).toBe('Long-press a message and tap Star.');
    expect(out).not.toContain('<svg');
    expect(html(StarredEmpty())).toContain('data-starred-empty');
  });

  it('first page loading shows skeleton cards, never the empty state', () => {
    const out = html(starredListView(viewProps({ feed: STARRED_LOADING })));
    expect(out).toContain('data-starred-loading');
    expect(out).not.toContain(STARRED_EMPTY_TITLE);
  });

  it('a row unstarred anywhere leaves at once (one source)', () => {
    const snapshot = { ...EMPTY_STARS, local: new Map([['a', false]]) };
    const out = html(starredListView(viewProps({ snapshot })));
    expect(out).not.toContain('data-starred-row="a"');
    expect(out).toContain('data-starred-row="b"');
  });

  it('preview: the first 3 rows, then See all', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => row(id));
    const out = html(
      starredListView(
        viewProps({
          feed: ready(rows),
          preview: { rows: 3, seeAll: <button data-see-all="">See all</button> },
        }),
      ),
    );
    expect(out.match(/data-starred-row=/g)).toHaveLength(3);
    expect(out).toContain('data-see-all');
    const few = html(
      starredListView(
        viewProps({ preview: { rows: 3, seeAll: <button data-see-all="">See all</button> } }),
      ),
    );
    expect(few).not.toContain('data-see-all');
  });

  it('full list: a sentinel loads the next page while one exists (never in preview)', () => {
    const next = { createdAt: '2026-10-01T10:00:00Z', id: 'b' };
    expect(html(starredListView(viewProps({ feed: ready([row('a')], next) })))).toContain(
      'data-starred-sentinel',
    );
    expect(starredCanPage(ready([row('a')], next), true)).toBe(false);
    expect(starredCanPage(ready([row('a')], null), false)).toBe(false);
  });

  it('edit mode: select circles and the Unstar (N) bar', () => {
    const out = html(starredListView(viewProps({ editing: true, selected: new Set(['a']) })));
    expect(out.match(/data-select-check=/g)).toHaveLength(2);
    expect(out).toContain('data-starred-bar');
    expect(out).toContain('Unstar (1)');
  });

  it('inline Edit control only where offered and only with rows', () => {
    const onEditingChange = vi.fn();
    expect(html(starredListView(viewProps({ onEditingChange })))).toContain(
      'data-starred-edit="edit"',
    );
    expect(html(starredListView(viewProps()))).not.toContain('data-starred-edit');
    expect(html(starredListView(viewProps({ onEditingChange, feed: ready([]) })))).not.toContain(
      'data-starred-edit',
    );
  });

  it('outside the chat page (no store) the list reads empty and reads nothing', () => {
    const out = html(
      <StarredList
        channelId="c1"
        showChat={false}
        channelsById={new Map()}
        currentUserId="u1"
        timeZone="UTC"
        onOpen={() => undefined}
      />,
    );
    expect(out).toContain(STARRED_EMPTY_TITLE);
  });

  it('inside the chat page the first paint is the loading state, never empty', () => {
    const store = createStarStore({
      workspaceId: 'w1',
      write: async () => ({ ok: true, data: null }),
    });
    const out = html(
      createElement(
        StarStoreContext.Provider,
        { value: store },
        <StarredList
          channelId={null}
          showChat
          channelsById={new Map()}
          currentUserId="u1"
          timeZone="UTC"
          onOpen={() => undefined}
        />,
      ),
    );
    expect(out).toContain('data-starred-loading');
  });
});

describe('Edit, Unstar: one write per chat among the selected rows', () => {
  it('groups by channel_id', async () => {
    const calls: Array<{ channelId: string; ids: readonly string[] }> = [];
    const store = createStarStore({
      workspaceId: 'w1',
      write: async (p) => {
        calls.push({ channelId: p.channelId, ids: p.messageIds });
        return { ok: true, data: null };
      },
    });
    const selected = [row('a'), row('b', { channelId: 'c2' }), row('c')];
    await store.toggle(
      selected.map((r) => ({ id: r.id, channelId: r.channelId })),
      false,
    );
    expect(calls).toEqual([
      { channelId: 'c1', ids: ['a', 'c'] },
      { channelId: 'c2', ids: ['b'] },
    ]);
  });
});

describe('sender names', () => {
  it('one batched read per page, only for senders nobody has loaded', () => {
    const rows = [
      row('a', { senderUserId: 'u2' }),
      row('b', { senderUserId: 'u3' }),
      row('c', { senderUserId: 'u2' }),
      row('d', { senderUserId: null }),
    ];
    expect(sendersToRead(rows, (id) => id === 'u3')).toEqual(['u2']);
  });
});
