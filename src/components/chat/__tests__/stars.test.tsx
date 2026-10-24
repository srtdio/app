import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// Stars across every surface: the menu row, the selection bar, the bubble's
// meta, the thread header button, the chat home chip and the info tab, all
// reading the one star store.

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/trace-context', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useNewTrace: () => () => 'trace',
}));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
// Pages that portal into document.body render in place here.
vi.mock('react-dom', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createPortal: (node: unknown) => node,
}));
vi.stubGlobal('document', { body: {} });

import { messageMenuItems, moreMenuItems } from '@/components/chat/MessageActionMenu';
import { SelectionBarView } from '@/components/chat/SelectionBar';
import { BubbleMetaView, MessageThread, type BubbleMeta } from '@/components/chat/MessageThread';
import {
  HOME_CHIPS,
  channelListContent,
  searchChips,
  searchKindOf,
  showSearchResults,
  toggleHomeChip,
} from '@/components/chat/ChannelList';
import {
  CONTACT_EMPTY,
  CONTACT_TABS,
  ChatInfoTabs,
  ChatInfoTabsView,
  PREVIEW_COUNT,
  starredTab,
  type ChatInfoTabsViewProps,
} from '@/components/chat/ChatInfoTabs';
import { starredListView } from '@/components/chat/StarredList';
import { ToastProvider } from '@/components/ui/toast';
import { PresignCache } from '@/lib/asset-presign';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  canStar,
  createStarStore,
  EMPTY_STARS,
  isStarredIn,
  listRowStarred,
  selectionStarAction,
  starredListArgs,
  StarStoreContext,
  type StarStore,
} from '@/lib/chat/stars';

const CREATED_AT = '2026-10-04T09:30:00.000Z';

function presignCache(): PresignCache {
  return new PresignCache({
    endpoint: null,
    getAccessToken: () => Promise.resolve(null),
    fetcher: () => Promise.reject(new Error('unused')),
  });
}

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer',
    body: 'Moved the shoot to Monday',
    createdAt: CREATED_AT,
    time: Date.parse(CREATED_AT),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function okStore(): { store: StarStore; calls: Array<{ channelId: string; ids: string[] }> } {
  const calls: Array<{ channelId: string; ids: string[] }> = [];
  const store = createStarStore({
    workspaceId: 'w1',
    write: async (p) => {
      calls.push({ channelId: p.channelId, ids: [...p.messageIds] });
      return { ok: true, data: null };
    },
  });
  return { store, calls };
}

function withStars(store: StarStore | null, el: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      store === null ? el : createElement(StarStoreContext.Provider, { value: store }, el),
    ),
  );
}

type ThreadProps = ComponentProps<typeof MessageThread>;
function thread(over: Partial<ThreadProps> = {}): ReactElement {
  const props: ThreadProps = {
    title: 'Diwali shoot',
    channelId: 'c1',
    profiles: new Map(),
    messages: [],
    loading: false,
    timeZone: 'UTC',
    canSend: true,
    onSend: () => undefined,
    marksLoaded: true,
    typingUserIds: [],
    currentUserId: 'me',
    ...over,
  };
  return createElement(MessageThread, props);
}

const noop = (): void => undefined;

describe('menu row', () => {
  const base = {
    canCopy: true,
    onReply: noop,
    onCopy: noop,
    canForward: true,
    canStar: true,
    canSaveToNotes: true,
    markOptions: ['commitment' as const],
    canRemind: true,
    canEdit: true,
    canDelete: true,
    canSelectText: true,
  };

  it('Star sits after Edit, before More, in the locked order', () => {
    expect(messageMenuItems(base).map((i) => i.key)).toEqual([
      'reply',
      'copy',
      'forward',
      'edit',
      'star',
      'more',
      'delete',
    ]);
    expect(moreMenuItems(base).map((i) => i.key)).toEqual([
      'select-text',
      'save-notes',
      'remind',
      'mark',
    ]);
  });

  it('stays top level on a voice note; Transcribe sits under More', () => {
    const voice = {
      ...base,
      canCopy: false,
      canTranscribe: true,
      canSelectText: false,
    };
    const keys = messageMenuItems(voice).map((i) => i.key);
    expect(keys.slice(0, 5)).toEqual(['reply', 'forward', 'edit', 'star', 'more']);
    expect(moreMenuItems(voice).map((i) => i.key)[0]).toBe('transcribe');
  });

  it('reads Star, or Unstar when starred', () => {
    const label = (starred: boolean): string | undefined => {
      const item = messageMenuItems({ ...base, starred }).find((i) => i.key === 'star');
      return item?.kind === 'action' ? item.label : undefined;
    };
    expect(label(false)).toBe('Star');
    expect(label(true)).toBe('Unstar');
  });

  it('hidden on tombstones, pending and failed sends (canStar false)', () => {
    expect(canStar(message({ deleted: true }))).toBe(false);
    expect(canStar(message({ state: 'sending' }))).toBe(false);
    expect(canStar(message({ state: 'failed' }))).toBe(false);
    expect(canStar(message({ mine: true }))).toBe(true);
    const keys = messageMenuItems({ ...base, canStar: false }).map((i) => i.key);
    expect(keys).not.toContain('star');
  });
});

describe('selection bar', () => {
  it('Unstar only when every selected message is starred, else Star', () => {
    const starred = new Set(['a', 'b']);
    expect(selectionStarAction(['a', 'b'], (id) => starred.has(id))).toBe('unstar');
    expect(selectionStarAction(['a', 'c'], (id) => starred.has(id))).toBe('star');
    const html = (action: 'star' | 'unstar'): string =>
      renderToStaticMarkup(
        SelectionBarView({
          count: 2,
          block: null,
          canDelete: true,
          onForward: noop,
          star: { action, onRun: noop },
          onDeleteTap: noop,
        }),
      );
    expect(html('star')).toContain('data-selection-star="star"');
    expect(html('star')).toContain('>Star<');
    expect(html('unstar')).toContain('>Unstar<');
    // Forward, Star, Delete.
    const out = html('star');
    expect(out.indexOf('data-selection-forward')).toBeLessThan(out.indexOf('data-selection-star'));
    expect(out.indexOf('data-selection-star')).toBeLessThan(out.indexOf('data-selection-delete'));
  });

  it('one batched call for the selection (one channel)', async () => {
    const { store, calls } = okStore();
    await store.toggle(
      ['a', 'b', 'c'].map((id) => ({ id, channelId: 'c1' })),
      true,
    );
    expect(calls).toEqual([{ channelId: 'c1', ids: ['a', 'b', 'c'] }]);
  });
});

describe('bubble meta', () => {
  const meta: BubbleMeta = { time: '9:30 AM', edited: true, status: null, starred: true };
  const render = (mine: boolean): string =>
    renderToStaticMarkup(BubbleMetaView({ meta, mine, placement: 'inline' }));

  it('a 12px filled star before "edited" and the time, both sides', () => {
    for (const mine of [true, false]) {
      const out = render(mine);
      expect(out).toContain('data-meta-star');
      expect(out).toContain('width="12"');
      expect(out.indexOf('data-meta-star')).toBeLessThan(out.indexOf('data-edited'));
      expect(out.indexOf('data-edited')).toBeLessThan(out.indexOf('9:30 AM'));
    }
  });

  it('own: the meta ink (white, as the time); incoming: fg-3', () => {
    expect(render(true)).not.toContain('text-fg-3');
    expect(render(true)).toContain('--bubble-meta-own');
    expect(render(false)).toContain('data-meta-star="" class="inline-flex text-fg-3"');
  });

  it('no star, no glyph', () => {
    const out = renderToStaticMarkup(
      BubbleMetaView({ meta: { ...meta, starred: false }, mine: false, placement: 'inline' }),
    );
    expect(out).not.toContain('data-meta-star');
  });

  it('light and dark snapshot of the meta (tokens only)', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    const value = (selector: string, name: string): string => {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(start, css.indexOf('}', start));
      const hit = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
      return (hit?.[1] ?? '').replace(String.fromCharCode(35), 'hex ');
    };
    const out = render(false) + render(true);
    expect(out).not.toContain(`${'dark'}:`);
    expect({
      light: { meta: value(':root', 'bubble-meta-own'), peer: value(':root', 'fg-3') },
      ['dark']: { meta: value('.dark', 'bubble-meta-own'), peer: value('.dark', 'fg-3') },
    }).toMatchInlineSnapshot(`
      {
        "dark": {
          "meta": "hex ffffff",
          "peer": "hex 6b7178",
        },
        "light": {
          "meta": "hex ffffff",
          "peer": "hex 8b9096",
        },
      }
    `);
  });
});

describe('thread', () => {
  it('first paint: a starred message paints its star with the first page', () => {
    const { store } = okStore();
    // ChatConnected holds the skeleton until the stars read settled; by then
    // the ids are in the store, so the first render with rows has the star.
    store.setChannel('c1', ['m1']);
    const out = withStars(store, thread({ messages: [message()] }));
    expect(out).toContain('data-meta-star');
  });

  it('a star or unstar shows on the bubble from the same store', async () => {
    const { store } = okStore();
    store.setChannel('c1', []);
    expect(withStars(store, thread({ messages: [message()] }))).not.toContain('data-meta-star');
    await store.toggle([{ id: 'm1', channelId: 'c1' }], true);
    expect(withStars(store, thread({ messages: [message()] }))).toContain('data-meta-star');
    store.drop(['m1']);
    expect(withStars(store, thread({ messages: [message({ deleted: true })] }))).not.toContain(
      'data-meta-star',
    );
  });

  it('header: "Starred messages" before "Search this chat" on DMs, groups and notes', () => {
    const { store } = okStore();
    for (const over of [{}, { isGroup: true }, { notes: true }] as Partial<ThreadProps>[]) {
      const out = withStars(store, thread(over));
      const star = out.indexOf('aria-label="Starred messages"');
      expect(star).toBeGreaterThan(-1);
      expect(star).toBeLessThan(out.indexOf('aria-label="Search this chat"'));
    }
    // Outside the chat page (no store) there is no star UI.
    expect(withStars(null, thread())).not.toContain('Starred messages');
  });
});

describe('chat home chips', () => {
  it('Starred first, then Photos, Links, Files, Voice notes', () => {
    expect(HOME_CHIPS.map((c) => c.label)).toEqual([
      'Starred',
      'Photos',
      'Links',
      'Files',
      'Voice notes',
    ]);
    const out = renderToStaticMarkup(searchChips({ kind: null, onChange: noop }));
    expect(out.indexOf('data-search-chip="starred"')).toBeLessThan(
      out.indexOf('data-search-chip="photo"'),
    );
    // The filled star in accent; the row scrolls on X, chips never wrap or shrink.
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain('text-accent');
    expect(out).toContain('flex-nowrap');
    expect(out).toContain('overflow-x-auto');
    expect(out).toContain('[scrollbar-width:none]');
    expect(out).toContain('touch-pan-x');
    expect(out).toContain('h-11 min-h-[44px]');
    expect(out).toContain('shrink-0');
    expect(out).toContain('whitespace-nowrap');
  });

  it('one at a time: Starred clears another chip and vice versa; tap again clears', () => {
    expect(toggleHomeChip('photo', 'starred')).toBe('starred');
    expect(toggleHomeChip('starred', 'link')).toBe('link');
    expect(toggleHomeChip('starred', 'starred')).toBeNull();
    expect(searchKindOf('starred')).toBeNull();
    expect(searchKindOf('file')).toBe('file');
  });

  it('Starred on: the starred list replaces the chats, Personal notes hidden', () => {
    expect(showSearchResults('', 'starred')).toBe(true);
    const notes: ChannelSummary = {
      channelId: 'notes__w1__me',
      channelType: 'notes',
      title: 'Personal notes',
      avatarUrl: null,
      createdBy: null,
      agoraGroupId: null,
      groupId: null,
      peerUserId: null,
      role: null,
      createdAt: '',
    };
    const out = renderToStaticMarkup(
      channelListContent({
        channels: [],
        status: 'ready',
        onRetry: noop,
        selectedChannelId: null,
        onSelect: noop,
        onNewChat: noop,
        notes,
        search: '',
        onSearchChange: noop,
        kind: 'starred',
        onKindChange: noop,
        searchResults: <div data-starred-home="" />,
      }),
    );
    expect(out).toContain('data-starred-home');
    expect(out).not.toContain('data-notes-tile');
  });

  it('Starred + 1 character lists all; 2+ characters narrow with p_query', () => {
    const args = (query: string): Record<string, unknown> =>
      starredListArgs({ workspaceId: 'w1', traceId: 't', query });
    expect(args('h')).not.toHaveProperty('p_query');
    expect(args('he').p_query).toBe('he');
  });
});

describe('Contact sheet and Group info: Starred tab', () => {
  it('tabs: Media, Files, Links, Starred, Marks; preview 3; empty copy', () => {
    expect(CONTACT_TABS.map((t) => t.label)).toEqual([
      'Media',
      'Files',
      'Links',
      'Starred',
      'Marks',
    ]);
    expect(PREVIEW_COUNT.starred).toBe(3);
    expect(CONTACT_EMPTY.starred).toBe('No starred messages');
  });

  const tabProps = (over: Partial<ChatInfoTabsViewProps> = {}): ChatInfoTabsViewProps => ({
    tab: 'starred',
    onTab: noop,
    attachments: null,
    links: null,
    onLoadMore: noop,
    onRetry: noop,
    cache: presignCache(),
    presignEnabled: false,
    timeZone: 'UTC',
    senderName: () => 'Unknown',
    onOpenImage: noop,
    marks: null,
    open: true,
    onJump: noop,
    mode: 'full',
    ...over,
  });

  it('the Starred tab shows its list (both modes)', () => {
    for (const mode of ['full', 'preview'] as const) {
      const out = renderToStaticMarkup(
        ChatInfoTabsView(tabProps({ mode, starred: <div data-probe="" /> })),
      );
      expect(out).toContain('data-contact-tab="starred"');
      expect(out).toContain('data-probe');
    }
  });

  it('Group info (preview, via shared ChatInfoTabs): 3 rows then See all; Contact sheet (full): all', () => {
    const base = {
      expanded: new Set<never>(),
      channelId: 'c1',
      profiles: new Map(),
      currentUserId: 'me',
      timeZone: 'UTC',
      onJump: noop,
      onSeeAll: noop,
    };
    const preview = starredTab({ ...base, mode: 'preview' });
    const pv = (preview.props as { preview?: { rows: number; seeAll: ReactElement } }).preview;
    expect(pv?.rows).toBe(3);
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      channelId: 'c1',
      senderUserId: 'peer',
      body: id,
      createdAt: CREATED_AT,
      mediaLine: '',
    }));
    const out = renderToStaticMarkup(
      starredListView({
        listId: 'c1',
        available: true,
        feed: { status: 'ready', rows, next: null, loadingMore: false, moreFailed: false },
        snapshot: EMPTY_STARS,
        rowProps: (r) => ({
          sender: 'Priya',
          chat: null,
          avatarUrl: null,
          mine: false,
          date: '9:30 AM',
          text: r.body,
        }),
        editing: false,
        selected: new Set(),
        onToggle: noop,
        onOpen: noop,
        busy: false,
        onUnstar: noop,
        onRetry: noop,
        ...(pv !== undefined ? { preview: pv } : {}),
      }),
    );
    expect(out.match(/data-starred-row=/g)).toHaveLength(3);
    expect(out).toContain('data-see-all');
    expect(out).toContain('See all');
    // Full mode (Contact sheet) and an expanded preview list everything.
    const full = starredTab({ ...base, mode: 'full' });
    expect((full.props as { preview?: unknown }).preview).toBeUndefined();
    const opened = starredTab({
      ...base,
      mode: 'preview',
      expanded: new Set(['starred'] as const),
    });
    expect((opened.props as { preview?: unknown }).preview).toBeUndefined();
    // No "› Chat" in the per-chat tab, and no Edit.
    expect((preview.props as { showChat: boolean }).showChat).toBe(false);
    expect((preview.props as { onEditingChange?: unknown }).onEditingChange).toBeUndefined();
  });

  it('lazy: nothing is read until the tab is opened (opens on Media)', () => {
    const { store } = okStore();
    const out = withStars(
      store,
      createElement(ChatInfoTabs, {
        channelId: 'c1',
        profiles: new Map(),
        currentUserId: 'me',
        timeZone: 'UTC',
        cache: presignCache(),
        presignEnabled: false,
        marks: null,
        onJump: noop,
        mode: 'preview',
      }),
    );
    expect(out).toContain('data-contact-tab="media"');
    expect(out).not.toContain('data-starred-list');
  });

  it('a star or unstar reaches the tab, the sheet and the home list from one source', async () => {
    const { store } = okStore();
    await store.toggle([{ id: 'm1', channelId: 'c1' }], true);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(true);
    expect(listRowStarred(store.getSnapshot(), 'm1')).toBe(true);
    await store.toggle([{ id: 'm1', channelId: 'c1' }], false);
    expect(isStarredIn(store.getSnapshot(), 'm1')).toBe(false);
    expect(listRowStarred(store.getSnapshot(), 'm1')).toBe(false);
  });

  it('light and dark snapshot of the Starred tab (tokens only)', () => {
    const row = {
      id: 'm1',
      channelId: 'c1',
      senderUserId: 'peer',
      body: 'Moved the shoot to Monday',
      createdAt: CREATED_AT,
      mediaLine: '',
    };
    const list = starredListView({
      listId: 'c1',
      available: true,
      feed: { status: 'ready', rows: [row], next: null, loadingMore: false, moreFailed: false },
      snapshot: EMPTY_STARS,
      rowProps: () => ({
        sender: 'Chitra',
        chat: null,
        avatarUrl: null,
        mine: false,
        date: '9:30 AM',
        text: row.body,
      }),
      editing: false,
      selected: new Set(),
      onToggle: noop,
      onOpen: noop,
      busy: false,
      onUnstar: noop,
      onRetry: noop,
    });
    const out = renderToStaticMarkup(ChatInfoTabsView(tabProps({ starred: list })));
    expect(out).not.toContain(`${'dark'}:`);
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    const names = [
      ...new Set([...out.matchAll(/\b(?:bg|text|border)-([a-z][\w-]*)/g)].map((m) => m[1] ?? '')),
    ].sort();
    const resolve = (selector: string): Record<string, string> => {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(start, css.indexOf('}', start));
      const out: Record<string, string> = {};
      for (const name of names) {
        const hit = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
        if (hit !== null) out[name] = (hit[1] ?? '').replace(String.fromCharCode(35), 'hex ');
      }
      return out;
    };
    expect({ light: resolve(':root'), ['dark']: resolve('.dark') }).toMatchInlineSnapshot(`
      {
        "dark": {
          "accent": "hex 6f79e3",
          "accent-line": "rgba(111, 121, 227, 0.34)",
          "accent-soft": "rgba(111, 121, 227, 0.16)",
          "border": "hex 23262c",
          "fg": "hex f4f5f6",
          "fg-2": "hex 9aa0a8",
          "fg-3": "hex 6b7178",
          "panel": "hex 141519",
          "panel-2": "hex 1a1c21",
          "panel-3": "hex 212329",
        },
        "light": {
          "accent": "hex 5e6ad2",
          "accent-line": "rgba(94, 106, 210, 0.3)",
          "accent-soft": "rgba(94, 106, 210, 0.1)",
          "border": "hex e6e8eb",
          "fg": "hex 1b1c20",
          "fg-2": "hex 62666d",
          "fg-3": "hex 8b9096",
          "panel": "hex ffffff",
          "panel-2": "hex f2f3f5",
          "panel-3": "hex ecedf0",
        },
      }
    `);
  });
});
