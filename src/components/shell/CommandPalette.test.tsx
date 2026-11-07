import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The unit env is `node` with no DOM, so CommandPalette is invoked as a plain
// function and its element tree walked (the Topbar test style). Hooks are
// shimmed to pure values so the body runs without a renderer.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => [
      typeof init === 'function' ? (init as () => unknown)() : init,
      () => {},
    ],
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useRef: (init: unknown) => ({ current: init }),
  };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

// Every touch of the Supabase client is recorded: the empty-search open must make none.
const spy = vi.hoisted(() => ({
  clientCalls: [] as string[],
  toasts: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/supabase', () => ({
  supabase: new Proxy(
    {},
    {
      get: (_target, prop) => {
        spy.clientCalls.push(String(prop));
        return () => {
          throw new Error('no network on the paint path');
        };
      },
    },
  ),
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({
    show: (options: Record<string, unknown>) => {
      spy.toasts.push(options);
      return 'toast-1';
    },
    dismiss: () => {},
  }),
}));

import {
  CommandPalette,
  RECENT_TITLE_CEILING_MS,
  RECENT_ZERO_COPY,
  RECENTS_CLEARED_TOAST,
  recentEntriesOf,
  emptyCopy,
  namesNeeded,
  PaletteBody,
  paletteSections,
  pickFooterLabel,
  pickMatches,
  pickPillLabel,
  pickZeroCopy,
  resolvePaletteNames,
  togglePicked,
  type PaletteItem,
  type PaletteSection,
  type ResultGroup,
} from '@/components/shell/CommandPalette';
import { rememberMentionNames, resetMentionNames } from '@/lib/chat/mentions';
import type { SearchHit } from '@/lib/chat/search';
import {
  readRecents,
  recentKey,
  recordRecent,
  type RecentEntry,
  type RecentItem,
  type RecentStorage,
} from '@/lib/recent-items';
import { UNDO_MS } from '@/lib/undo';
import { mapWorkspaceRow } from '@/lib/search/workspace-search';
import type {
  KindCounts,
  PaletteSearchState,
  WorkspaceHit,
  WorkspaceKind,
} from '@/lib/search/workspace-search';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

/** Walk the tree, expanding function components (PaletteBody) as it goes. */
function expand(node: ReactNode): ReactNode {
  if (isElement(node) && typeof node.type === 'function') {
    return expand((node.type as (p: unknown) => ReactNode)(node.props));
  }
  return node;
}

function texts(node: ReactNode, out: string[] = []): string[] {
  node = expand(node);
  if (Array.isArray(node)) {
    node.forEach((child) => texts(child, out));
    return out;
  }
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (!isElement(node)) return out;
  texts((node.props as { children?: ReactNode }).children, out);
  return out;
}

function findAll(node: ReactNode, attr: string, out: ReactElement[] = []): ReactElement[] {
  node = expand(node);
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, attr, out));
    return out;
  }
  if (!isElement(node)) return out;
  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  if (attr in props) out.push(node);
  findAll(props.children, attr, out);
  return out;
}

const NOW = Date.parse('2026-10-16T12:00:00Z');
const WS = '0190a000-0000-7000-8000-00000000a001';
const ASHA = '0190a000-0000-7000-8000-0000000000a1';
const GONE = '0190a000-0000-7000-8000-0000000000a2';
const NEW = '0190a000-0000-7000-8000-0000000000a3';
const ME = '0190a000-0000-7000-8000-0000000000a4';
const RAW_TOKEN = /@\[[^\]]*\]?/;

function wsHit(kind: WorkspaceKind, n: number, extra: Partial<WorkspaceHit> = {}): WorkspaceHit {
  return {
    kind,
    id: `${kind}${n}`,
    parentId: kind === 'comment' ? `e${n}` : kind === 'plan_item' ? 'plan1' : null,
    channelId: kind === 'task' || kind === 'chat_group' ? 'group__w__g' : null,
    entityType: kind === 'brief' ? 'brief' : 'post',
    number: n,
    title: `Diwali ${kind} ${n}`,
    snippet: 'festive lights',
    actorUserId: ASHA,
    actorIsMember: true,
    createdAt: '2026-10-16T11:00:00Z',
    ...extra,
  };
}

const chatHit: SearchHit = {
  id: 'm1',
  channelId: 'group__w__g',
  senderUserId: ASHA,
  body: 'diwali plan is ready',
  createdAt: '2026-10-16T11:30:00Z',
  mediaLine: '',
};

function ready(
  query: string,
  workspace: WorkspaceHit[],
  chat: SearchHit[],
  counts: KindCounts = {},
): PaletteSearchState {
  return { query, status: 'ready', workspace, counts, chat, full: [] };
}

function sections(
  query: string,
  search: PaletteSearchState,
  expanded: ReadonlySet<ResultGroup> = new Set(),
  recents: RecentEntry[] = [],
): PaletteSection[] {
  return paletteSections({
    query,
    search,
    recents,
    expanded,
    workspaceId: WS,
    workspaceKey: 'GBL',
    nowMs: NOW,
    timeZone: 'UTC',
  });
}

function body(
  query: string,
  search: PaletteSearchState,
  onPick: (item: PaletteItem) => void = () => {},
  recents: RecentEntry[] = [],
) {
  return PaletteBody({
    query,
    search,
    sections: sections(query, search, new Set(), recents),
    active: 0,
    onHover: () => {},
    onPick,
    onRetry: () => {},
  });
}

const IDLE: PaletteSearchState = {
  query: '',
  status: 'idle',
  workspace: [],
  counts: {},
  chat: [],
  full: [],
};

beforeEach(() => {
  resetMentionNames();
  rememberMentionNames(WS, [{ userId: ASHA, displayName: 'Asha Rao', username: 'asha' }]);
});

describe('CommandPalette', () => {
  const props = {
    open: true,
    onClose: () => {},
    workspaceId: WS,
    workspaceKey: 'GBL',
    userId: ME,
  };

  it('says "Search anything" and has no Go to list', () => {
    const tree = CommandPalette(props);
    const input = findAll(tree, 'placeholder')[0];
    expect((input?.props as { placeholder: string }).placeholder).toBe('Search anything');
    const all = texts(tree);
    for (const gone of ['Go to', 'Pipeline', 'Activity', 'Help', 'No results']) {
      expect(all).not.toContain(gone);
    }
  });

  it('renders as a full-screen sheet on phones with a 44px Cancel, and an Esc chip on laptops', () => {
    const tree = CommandPalette(props);
    const dialog = findAll(tree, 'role').find(
      (el) => (el.props as { role: string }).role === 'dialog',
    );
    expect((dialog?.props as { className: string }).className).toContain('h-full');
    expect((dialog?.props as { className: string }).className).toContain('sm:max-w-xl');
    const all = texts(tree);
    expect(all).toContain('Cancel');
    expect(all).toContain('Esc');
  });

  it('dims with the scrim token (light and dark), never a hardcoded black', () => {
    const tree = CommandPalette(props);
    const overlay = findAll(tree, 'data-palette-overlay')[0];
    const className = (overlay?.props as { className: string }).className;
    expect(className).toContain('bg-scrim');
    expect(className).not.toMatch(/bg-black/);
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');
    const decls = [...css.matchAll(/--scrim:\s*([^;]+);/g)].map((m) => m[1]);
    // One value in :root (light), one in the dark block.
    expect(decls).toHaveLength(2);
    expect(decls[0]).not.toBe(decls[1]);
    const dark = css.slice(css.indexOf('.dark'));
    expect(dark).toMatch(/--scrim:/);
  });

  it('empty search shows RECENT with the type line, newest first', () => {
    const recents: RecentEntry[] = [
      { type: 'group', id: 'g', title: 'Launch crew', target: { path: '/chat?channel=x' } },
      { type: 'post', id: 'p', title: 'Monday carousel', target: { path: '/p/gbl-1' } },
      { type: 'person', id: ASHA, title: 'Asha Rao', target: { person: ASHA } },
    ];
    const s = sections('', IDLE, new Set(), recents);
    expect(s.map((x) => x.label)).toEqual(['Recent']);
    const all = texts(body('', IDLE, () => {}, recents));
    expect(all).toEqual(
      expect.arrayContaining([
        'Recent',
        'Launch crew',
        'Group',
        'Monday carousel',
        'Post',
        'Person',
      ]),
    );
    expect(sections('', IDLE)).toEqual([]);
  });

  it('renders groups in order and hides empty ones', () => {
    const search = ready(
      'diwali',
      [
        wsHit('chat_group', 9),
        wsHit('task', 8),
        wsHit('plan_item', 7),
        wsHit('plan', 6),
        wsHit('file', 5),
        wsHit('comment', 3),
        wsHit('brief', 2),
        wsHit('post', 1),
        wsHit('person', 0, { title: 'Diwali Das', snippet: 'ddas' }),
      ],
      [chatHit],
    );
    const groups = findAll(body('diwali', search), 'data-palette-group').map(
      (el) => (el.props as Record<string, string>)['data-palette-group'],
    );
    expect(groups).toEqual([
      'People',
      'Posts',
      'Briefs',
      'Comments',
      'Files',
      'Plans',
      'Plan items',
      'Tasks',
      'Groups',
      'Chat',
    ]);
    const only = ready('diwali', [wsHit('post', 1)], []);
    expect(sections('diwali', only).map((x) => x.label)).toEqual(['Posts']);
  });

  it('plan item comments and activity get their own groups, last of their neighbours', () => {
    const search = ready(
      'diwali',
      [
        wsHit('activity', 10, {
          snippet: 'comment',
          entityType: 'post',
          parentId: 'p10',
          actorUserId: null,
          title: 'Launch reel',
        }),
        wsHit('plan_item_comment', 7, {
          id: 'plan_item7',
          parentId: 'plan1',
          entityType: 'plan_item',
        }),
        wsHit('plan_item', 7),
        wsHit('task', 8),
      ],
      [chatHit],
    );
    expect(sections('diwali', search).map((x) => x.label)).toEqual([
      'Plan items',
      'Plan comments',
      'Tasks',
      'Chat',
      'Activity',
    ]);
  });

  it('a plan item and its comment hit share an id but never a row id or key', () => {
    const search = ready(
      'diwali',
      [
        wsHit('plan_item', 7),
        wsHit('plan_item_comment', 7, {
          id: 'plan_item7',
          parentId: 'plan1',
          entityType: 'plan_item',
        }),
      ],
      [],
    );
    const ids = sections('diwali', search).flatMap((x) => x.items.map((item) => item.id));
    expect(ids).toEqual(['plan_item-plan_item7', 'plan_item_comment-plan_item7']);
    expect(new Set(ids).size).toBe(ids.length);
    // Every rendered row is keyed by its section and its kind-prefixed id.
    const src = readFileSync(
      fileURLToPath(new URL('./CommandPalette.tsx', import.meta.url)),
      'utf8',
    );
    expect(src.match(/key=\{`\$\{section\.label\}:\$\{item\.id\}`\}/g)).toHaveLength(4);
    expect(src).not.toMatch(/key=\{item\.id\}/);
    // Both open the item in its plan.
    const targets = sections('diwali', search).flatMap((x) =>
      x.items.flatMap((item) => (item.type === 'result' ? [item.target] : [])),
    );
    expect(targets).toEqual([
      { path: '/plan/plan1?q=diwali&at=plan_item7' },
      { path: '/plan/plan1?q=diwali&at=plan_item7' },
    ]);
  });

  it("an activity row reads the feed's own line for its event type and opens its subject", () => {
    const search = ready(
      'launch',
      [
        wsHit('activity', 10, {
          snippet: 'comment',
          entityType: 'post',
          parentId: 'p10',
          number: 4,
          actorUserId: null,
          title: 'Launch reel',
        }),
      ],
      [],
    );
    const row = sections('launch', search)[0]?.items[0];
    expect(row).toMatchObject({
      type: 'result',
      group: 'Activity',
      title: 'Launch reel',
      snippet: 'New comment on Launch reel',
      target: { path: '/p/gbl-4?q=launch' },
    });
  });

  it('caps each type at 5 with "Show all (N)", N the server total', () => {
    const five = Array.from({ length: 5 }, (_, i) => wsHit('post', i + 1));
    const search = ready('diwali', five, [], { post: 37 });
    const posts = sections('diwali', search).find((s) => s.label === 'Posts');
    expect(posts?.items.filter((i) => i.type === 'result')).toHaveLength(5);
    expect(posts?.items.at(-1)).toMatchObject({ type: 'more', group: 'Posts', count: 37 });
    expect(texts(body('diwali', search))).toContain('Show all (37)');
    // Exactly 5 matches: no Show all.
    const exact = ready('diwali', five, [], { post: 5 });
    const plain = sections('diwali', exact).find((s) => s.label === 'Posts');
    expect(plain?.items.some((i) => i.type === 'more')).toBe(false);
    // Expanded: every fetched row, no Show all.
    const twenty = Array.from({ length: 20 }, (_, i) => wsHit('post', i + 1));
    const open = sections('diwali', ready('diwali', twenty, [], { post: 37 }), new Set(['Posts']));
    const expanded = open.find((s) => s.label === 'Posts');
    expect(expanded?.items).toHaveLength(20);
    expect(expanded?.items.some((i) => i.type === 'more')).toBe(false);
  });

  it('the chat group keeps its own 5 + Show all over the fetched hits', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...chatHit, id: `m${i}` }));
    const chat = sections('diwali', ready('diwali', [], many)).find((s) => s.label === 'Chat');
    expect(chat?.items.at(-1)).toMatchObject({ type: 'more', count: 12 });
  });

  it('each kind lands on its target through the one jump helper, with the searched words', () => {
    const search = ready(
      'diwali',
      [
        wsHit('person', 0, { id: ASHA }),
        wsHit('post', 1),
        wsHit('brief', 2),
        wsHit('comment', 3, { entityType: 'post' }),
        wsHit('comment', 4, { entityType: 'brief' }),
        wsHit('file', 5),
        wsHit('plan', 6),
        wsHit('plan_item', 7),
        wsHit('task', 8),
        wsHit('chat_group', 9),
      ],
      [chatHit],
    );
    const picked: unknown[] = [];
    const tree = body('diwali', search, (item) => {
      if (item.type !== 'more') picked.push(item.target);
    });
    for (const el of findAll(tree, 'data-palette-item')) {
      (el.props as { onClick: () => void }).onClick();
    }
    expect(picked).toEqual([
      { person: ASHA },
      { path: '/p/gbl-1?q=diwali' },
      { path: '/b/gbl-2?q=diwali' },
      { path: '/p/gbl-3?comment=comment3&q=diwali' },
      { path: '/b/gbl-4?comment=comment4&q=diwali' },
      { path: '/assets?asset=file5&q=diwali' },
      { path: '/plan/plan6?q=diwali' },
      { path: '/plan/plan1?q=diwali&at=plan_item7' },
      { path: '/chat?channel=group__w__g&task=task8&q=diwali' },
      { path: '/chat?channel=group__w__g&q=diwali' },
      { path: '/chat?channel=group__w__g&message=m1&q=diwali' },
    ]);
  });

  it('shows the chat sender, highlights matched words, and the chat time (formatAgo)', () => {
    const tree = body('diwali', ready('diwali', [], [chatHit]));
    const all = texts(tree);
    expect(all).toContain('asha');
    expect(sections('diwali', ready('diwali', [], [chatHit]))[0]?.items[0]).toMatchObject({
      title: 'asha',
    });
    expect(all).toContain('30m');
    const marked = findAll(tree, 'data-search-mark').map((el) => texts(el).join(''));
    expect(marked).toContain('diwali');
  });

  it('never renders a raw mention token; mentions show @username', () => {
    const search = ready(
      'diwali',
      [
        wsHit('post', 1, { snippet: `diwali with @[${ASHA}] tonight` }),
        // A snippet cut inside a token: mapping drops the tail.
        mapWorkspaceRow({
          kind: 'comment',
          id: 'c2',
          parent_id: 'e2',
          channel_id: '',
          entity_type: 'post',
          number: 2,
          title: 'Diwali post',
          snippet: `diwali ask @[${ASHA}] and @[0190a000-00`,
          actor_user_id: ASHA,
          actor_is_member: true,
          created_at: '2026-10-16T11:00:00Z',
        }) as WorkspaceHit,
      ],
      [{ ...chatHit, body: `diwali @[${ASHA}] @[all] done` }],
    );
    const all = texts(body('diwali', search)).join('\n');
    expect(all).not.toMatch(RAW_TOKEN);
    expect(all).toContain('@asha');
    expect(all).toContain('@all');
  });

  it('plain typed text stays as typed', () => {
    const search = ready('diwali', [wsHit('post', 1, { snippet: 'diwali for @asha today' })], []);
    const line = sections('diwali', search)[0]?.items[0];
    expect(line).toMatchObject({ snippet: 'diwali for @asha today' });
  });

  it('a removed member reads "Former member", as a mention and as an actor', async () => {
    await resolvePaletteNames(WS, [GONE], async () => ({ ok: true, data: [] }));
    const search = ready(
      'diwali',
      [
        wsHit('comment', 1, {
          snippet: `diwali by @[${GONE}]`,
          actorUserId: GONE,
          actorIsMember: false,
        }),
      ],
      [{ ...chatHit, senderUserId: GONE }],
    );
    const s = sections('diwali', search);
    const comment = s.find((x) => x.label === 'Comments')?.items[0];
    expect(comment).toMatchObject({ snippet: 'Former member: diwali by Former member' });
    const chat = s.find((x) => x.label === 'Chat')?.items[0];
    expect(chat).toMatchObject({ title: 'Former member' });
    const all = texts(body('diwali', search)).join('\n');
    expect(all).not.toContain('Unknown member');
  });

  it('an uncached current member resolves to their name with one batched read', async () => {
    const read = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: ids.map((userId) => ({
        userId,
        displayName: 'Nikhil Shah',
        username: 'nikhil',
        avatarUrl: null,
        member: true,
      })),
    }));
    const hits = [
      wsHit('post', 1, { snippet: `diwali @[${NEW}]` }),
      wsHit('comment', 2, { snippet: `diwali @[${NEW}] @[${ASHA}]`, actorUserId: NEW }),
    ];
    const chat = [{ ...chatHit, senderUserId: NEW, body: `diwali @[${NEW}]` }];
    await resolvePaletteNames(WS, namesNeeded(hits, chat), read);
    expect(read).toHaveBeenCalledTimes(1);
    // Only the unknown id, once (Asha is cached).
    expect(read).toHaveBeenCalledWith([NEW.toLowerCase()]);
    const all = texts(body('diwali', ready('diwali', hits, chat))).join('\n');
    expect(all).toContain('@nikhil');
    expect(all).not.toContain('Unknown member');
    // Known now: no second read.
    await resolvePaletteNames(WS, namesNeeded(hits, chat), read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale response for an older query', () => {
    const stale = ready('diw', [wsHit('post', 1)], []);
    expect(sections('diwali', stale).map((s) => s.label)).toEqual([]);
  });

  it('shows loading, empty and error states', () => {
    const loading: PaletteSearchState = { ...IDLE, query: 'diwali', status: 'loading' };
    expect(texts(body('diwali', loading))).toContain('Searching…');

    expect(texts(body('diwali', ready('diwali', [], [])))).toContain(emptyCopy('diwali'));
    expect(emptyCopy(' diwali ')).toBe('Try another word for "diwali".');

    let retried = 0;
    const errTree = PaletteBody({
      query: 'diwali',
      search: { ...IDLE, query: 'diwali', status: 'error' },
      sections: [],
      active: 0,
      onHover: () => {},
      onPick: () => {},
      onRetry: () => (retried += 1),
    });
    expect(texts(errTree)).toContain("Couldn't search. Try again.");
    const retry = findAll(errTree, 'data-palette-retry')[0];
    (retry?.props as { onClick: () => void }).onClick();
    expect(retried).toBe(1);
  });

  it('every row is at least 44px tall', () => {
    const search = ready('diwali', [wsHit('post', 1)], [], { post: 9 });
    for (const el of findAll(body('diwali', search), 'data-palette-item')) {
      expect((el.props as { className: string }).className).toContain('min-h-11');
    }
  });

  it('marks the keyboard row as selected', () => {
    const search = ready('diwali', [wsHit('post', 1), wsHit('post', 2)], []);
    const tree = PaletteBody({
      query: 'diwali',
      search,
      sections: sections('diwali', search),
      active: 1,
      onHover: () => {},
      onPick: () => {},
      onRetry: () => {},
    });
    const selected = findAll(tree, 'data-palette-item').map(
      (el) => (el.props as { 'aria-selected': boolean })['aria-selected'],
    );
    expect(selected).toEqual([false, true]);
    // The keyboard-selected row is lit-selected; every row takes the lit-hover
    // press overlay from PressableRow.
    const classes = findAll(tree, 'data-palette-item').map(
      (el) => (el.props as { className: string }).className,
    );
    expect(classes[1]).toContain('lit-selected');
    expect(classes[0]).not.toContain('lit-selected');
    for (const cls of classes) expect(cls).not.toMatch(/(^|\s)(active:)?bg-accent-soft/);
  });

  it('marks every matched word, inside a rendered @username too', () => {
    rememberMentionNames(WS, [{ userId: ASHA, displayName: 'Asha Rao', username: 'ashadiwali' }]);
    const search = ready(
      'diwali',
      [wsHit('post', 1, { snippet: `Diwali ask @[${ASHA}] now` })],
      [],
    );
    const tree = body('diwali', search);
    const marked = findAll(tree, 'data-search-mark').map((el) => texts(el).join(''));
    // Word-prefix rule: "Diwali" marks in the title and the snippet (case kept).
    expect(marked).toContain('Diwali');
    const mention = ready('asha', [wsHit('post', 2, { snippet: `ping @[${ASHA}] now` })], []);
    const mentionMarks = findAll(body('asha', mention), 'data-search-mark').map((el) =>
      texts(el).join(''),
    );
    expect(mentionMarks).toContain('ashadiwali');
  });

  it('a current member whose name has not loaded is never "Former member"', async () => {
    const failed = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'unknown' as const, message: 'timeout' },
    }));
    const hits = [wsHit('post', 1, { snippet: `diwali @[${NEW}]` })];
    const chat = [{ ...chatHit, senderUserId: NEW, body: `diwali @[${NEW}]` }];
    await resolvePaletteNames(WS, namesNeeded(hits, chat), failed);
    const rows = sections('diwali', ready('diwali', hits, chat)).flatMap((sec) => sec.items);
    const all = texts(body('diwali', ready('diwali', hits, chat))).join('\n');
    expect(all).not.toContain('Former member');
    expect(all).not.toMatch(RAW_TOKEN);
    expect(rows.find((r) => r.id === 'chat-m1')).toMatchObject({ title: '' });
  });
});

function memoryStorage(): RecentStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function titled(n: number): RecentItem {
  return {
    type: 'post',
    id: `p${n}`,
    openedAt: 100 - n,
    title: `Recent post ${n}`,
    target: { path: `/p/gbl-${n}` },
  };
}

describe('CommandPalette Recent from the device', () => {
  const props = {
    open: true,
    onClose: () => {},
    workspaceId: WS,
    workspaceKey: 'GBL',
    userId: ME,
  };
  let storage: RecentStorage;

  function seed(items: RecentItem[]): void {
    storage.setItem(recentKey(ME, WS), JSON.stringify(items));
  }

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    spy.clientCalls.length = 0;
    spy.toasts.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('cached recents render on the first render with zero client calls', () => {
    seed([titled(1), titled(2), titled(3)]);
    const tree = CommandPalette(props);
    const all = texts(tree);
    expect(all).toEqual(
      expect.arrayContaining(['Recent post 1', 'Recent post 2', 'Recent post 3']),
    );
    expect(all).not.toContain('Searching…');
    expect(spy.clientCalls).toEqual([]);
  });

  it('guard: the header offers Clear all and every recent row has its remove button', () => {
    seed([titled(1), titled(2), titled(3)]);
    const tree = CommandPalette(props);
    const clear = findAll(tree, 'data-palette-clear-recents');
    expect(clear).toHaveLength(1);
    expect(texts(clear[0])).toEqual(['Clear all']);
    const rows = findAll(tree, 'data-palette-item');
    const removes = findAll(tree, 'data-palette-recent-remove');
    expect(removes).toHaveLength(rows.length);
    expect(removes.map((el) => (el.props as Record<string, string>)['aria-label'])).toEqual([
      'Remove Recent post 1',
      'Remove Recent post 2',
      'Remove Recent post 3',
    ]);
    // The field keeps focus: X and Clear all never take it.
    for (const el of [...removes, ...clear]) {
      const prevent = vi.fn();
      (el.props as { onMouseDown: (e: unknown) => void }).onMouseDown({ preventDefault: prevent });
      expect(prevent).toHaveBeenCalledTimes(1);
    }
    expect(spy.clientCalls).toEqual([]);
  });

  it('X removes that one recent from storage, no toast, no read', () => {
    seed([titled(1), titled(2)]);
    const remove = findAll(CommandPalette(props), 'data-palette-recent-remove').find(
      (el) => (el.props as Record<string, string>)['data-palette-recent-remove'] === 'p1',
    );
    (remove?.props as { onClick: () => void }).onClick();
    expect(readRecents(storage, ME, WS).map((i) => i.id)).toEqual(['p2']);
    expect(spy.toasts).toEqual([]);
    expect(spy.clientCalls).toEqual([]);
  });

  it('shows the newest 8 and "Show all (N)" beyond them; expanded shows every one', () => {
    seed(Array.from({ length: 12 }, (_, i) => titled(i + 1)));
    const tree = CommandPalette(props);
    expect(texts(tree)).toContain('Show all (12)');
    const rows = findAll(tree, 'data-palette-item').map(
      (el) => (el.props as Record<string, string>)['data-palette-item'],
    );
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toBe('more-recent');
    const recents = recentEntriesOf(readRecents(storage, ME, WS), new Set(), new Map());
    const open = paletteSections({
      query: '',
      search: IDLE,
      recents,
      expanded: new Set(),
      recentsExpanded: true,
      workspaceId: WS,
      workspaceKey: 'GBL',
      nowMs: NOW,
    });
    expect(open[0]?.items).toHaveLength(12);
    expect(open[0]?.items.some((i) => i.type === 'more')).toBe(false);
    expect(spy.clientCalls).toEqual([]);
  });

  it('Clear all: zero line at once, the Undo strip for UNDO_MS, Undo restores, expiry commits', () => {
    seed([titled(1), titled(2)]);
    const clear = findAll(CommandPalette(props), 'data-palette-clear-recents')[0];
    (clear?.props as { onClick: () => void }).onClick();
    expect(spy.toasts).toHaveLength(1);
    const toast = spy.toasts[0] as {
      title: string;
      durationMs: number;
      kind: string;
      action: { label: string; onPress: () => void };
      onExpire: () => void;
    };
    expect(toast).toMatchObject({
      title: RECENTS_CLEARED_TOAST,
      durationMs: UNDO_MS,
      kind: 'undo',
    });
    expect(toast.action.label).toBe('Undo');
    // Held back until the strip ends: a reopen shows the zero line, storage untouched.
    expect(texts(CommandPalette(props))).toContain(RECENT_ZERO_COPY);
    expect(readRecents(storage, ME, WS)).toHaveLength(2);
    toast.action.onPress();
    expect(texts(CommandPalette(props))).toEqual(
      expect.arrayContaining(['Recent post 1', 'Recent post 2']),
    );

    // A second clear commits on expiry; an item opened during the window stays.
    const again = findAll(CommandPalette(props), 'data-palette-clear-recents')[0];
    (again?.props as { onClick: () => void }).onClick();
    recordRecent(storage, ME, WS, { type: 'plan', id: 'pl1' }, 500);
    (spy.toasts[1] as { onExpire: () => void }).onExpire();
    expect(readRecents(storage, ME, WS).map((i) => i.id)).toEqual(['pl1']);
    expect(spy.clientCalls).toEqual([]);
  });

  it('no recents shows the one zero line, no button', () => {
    const tree = CommandPalette(props);
    expect(texts(tree)).toContain(RECENT_ZERO_COPY);
    expect(findAll(tree, 'data-palette-clear-recents')).toEqual([]);
    expect(RECENT_ZERO_COPY).toBe('Things you open show up here.');
    expect(spy.clientCalls).toEqual([]);
  });

  it('typed search is unchanged: no zero line, no Clear all', () => {
    const search = ready('diwali', [wsHit('post', 1)], [], { post: 9 });
    const tree = body('diwali', search);
    expect(texts(tree)).not.toContain(RECENT_ZERO_COPY);
    expect(findAll(tree, 'data-palette-clear-recents')).toEqual([]);
    expect(texts(tree)).toContain('Show all (9)');
  });

  it('uncached rows wait on the ceiling path; cached rows paint at once', () => {
    expect(RECENT_TITLE_CEILING_MS).toBe(600);
    const items: RecentItem[] = [titled(1), { type: 'post', id: 'p-new', openedAt: 200 }];
    seed(items);
    const first = texts(CommandPalette(props));
    expect(first).toContain('Recent post 1');
    expect(spy.clientCalls).toEqual([]);
    // Once the batched read lands, the untitled row joins.
    const fetched = new Map([['post:p-new', { title: 'Fresh', target: { path: '/p/gbl-9' } }]]);
    expect(
      recentEntriesOf(readRecents(storage, ME, WS), new Set(), fetched).map((e) => e.title),
    ).toEqual(['Fresh', 'Recent post 1']);
  });
});

describe('pick mode renders outside #root', () => {
  it('portals to <body> in pick mode (a picker Sheet holds #root aria-hidden)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./CommandPalette.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(
      /pickMode && typeof document !== 'undefined'\s*\?\s*createPortal\(palette, document\.body\)/,
    );
  });
});

describe('recent titles freshness pass', () => {
  // Effects are shimmed in this env, so the effect's wiring is read from source.
  const src = readFileSync(fileURLToPath(new URL('./CommandPalette.tsx', import.meta.url)), 'utf8');
  const start = src.indexOf('// Freshness: once per session per workspace');
  const effect = src.slice(start, src.indexOf('}, [', start) + 60);

  it('a workspace key arriving while the palette is open does not start a second pass', () => {
    // The key is read through a ref at pass time, never an effect dependency.
    expect(effect).toContain('workspaceKey: workspaceKeyRef.current');
    expect(effect).toContain('}, [open, pickMode, workspaceId, userId]);');
    expect(effect).not.toMatch(/\}, \[[^\]]*workspaceKey[^\]]*\]\);/);
    expect(src).toContain('workspaceKeyRef.current = workspaceKey;');
  });
});

describe("CommandPalette pick mode (a picker's search)", () => {
  const props = {
    open: true,
    onClose: () => {},
    workspaceId: WS,
    workspaceKey: 'GBL',
    userId: ME,
  };

  function pickSections(
    query: string,
    search: PaletteSearchState,
    kinds: Parameters<typeof pickMatches>[1],
  ) {
    return paletteSections({
      query,
      search,
      recents: [],
      expanded: new Set(),
      workspaceId: WS,
      workspaceKey: 'GBL',
      nowMs: NOW,
      timeZone: 'UTC',
      pick: kinds,
    });
  }

  const mixed = ready(
    'diwali',
    [
      wsHit('person', 0, { title: 'Diwali Das', snippet: 'ddas' }),
      wsHit('post', 1),
      wsHit('post', 2),
      wsHit('post', 3),
      wsHit('post', 4),
      wsHit('post', 5),
      wsHit('post', 6),
      wsHit('brief', 7),
      wsHit('chat_group', 8),
      wsHit('plan_item', 9),
      wsHit('plan_item', 10, { parentId: null }),
    ],
    [chatHit],
    { post: 40 },
  );

  it('shows only the picked kinds, in the RESULT_GROUPS order, no chat, no "Show all"', () => {
    const s = pickSections('diwali', mixed, ['chat_group', 'person']);
    expect(s.map((x) => x.label)).toEqual(['People', 'Groups']);
    const posts = pickSections('diwali', mixed, ['post']);
    expect(posts.map((x) => x.label)).toEqual(['Posts']);
    // Every fetched row (the full page), never a "more" row.
    expect(posts[0]?.items).toHaveLength(6);
    expect(posts[0]?.items.some((i) => i.type === 'more')).toBe(false);
    // Each row carries its hit for onPick.
    const first = posts[0]?.items[0];
    expect(first?.type === 'result' ? first.hit?.id : null).toBe('post1');
  });

  it('a bank idea is a plan item with no plan', () => {
    expect(pickMatches(wsHit('plan_item', 10, { parentId: null }), ['bank_idea'])).toBe(true);
    expect(pickMatches(wsHit('plan_item', 9), ['bank_idea'])).toBe(false);
    expect(pickMatches(wsHit('post', 1), ['bank_idea'])).toBe(false);
    const s = pickSections('diwali', mixed, ['bank_idea']);
    expect(s.map((x) => x.label)).toEqual(['Plan items']);
    expect(s[0]?.items.map((i) => i.id)).toEqual(['plan_item-plan_item10']);
  });

  it('an empty search shows no Recent, only the pick zero line', () => {
    expect(pickSections('', mixed, ['post'])).toEqual([]);
    const tree = PaletteBody({
      query: '',
      search: IDLE,
      sections: [],
      active: 0,
      onHover: () => {},
      onPick: () => {},
      onRetry: () => {},
      pick: { picked: new Set(), zeroCopy: pickZeroCopy(['person', 'chat_group'], 'Chats') },
    });
    expect(texts(tree)).toContain('Chats show up here.');
    expect(texts(tree)).not.toContain(RECENT_ZERO_COPY);
  });

  it('the pill reads "<Kind> only"; the footer "Send N" / "Add N"', () => {
    expect(pickPillLabel(['person', 'chat_group'], 'Chats')).toBe('Chats only');
    expect(pickPillLabel(['plan'])).toBe('Plans only');
    expect(pickPillLabel(['bank_idea'])).toBe('Ideas only');
    expect(pickFooterLabel('Send', 2)).toBe('Send 2');
    expect(pickFooterLabel('Add', 1)).toBe('Add 1');
  });

  it('a tap ticks with ui/SelectCheck instead of opening', () => {
    const s = pickSections('diwali', mixed, ['post']);
    const picked: PaletteItem[] = [];
    const tree = PaletteBody({
      query: 'diwali',
      search: mixed,
      sections: s,
      active: 0,
      onHover: () => {},
      onPick: (item) => picked.push(item),
      onRetry: () => {},
      pick: { picked: new Set(['post-post2']), zeroCopy: '' },
    });
    const rows = findAll(tree, 'data-palette-pick');
    expect(rows).toHaveLength(6);
    const states = rows.map((el) => (el.props as Record<string, string>)['data-palette-pick']);
    expect(states.filter((x) => x === 'on')).toHaveLength(1);
    // The one select circle (ui/SelectCheck) on every row, on for the ticked one.
    const checks = findAll(tree, 'data-select-check').map(
      (el) => (el.props as Record<string, string>)['data-select-check'],
    );
    expect(checks).toHaveLength(6);
    expect(checks.filter((x) => x === 'on')).toHaveLength(1);
    // Selected is the tick in pick mode.
    const ticked = rows.find(
      (el) => (el.props as Record<string, unknown>)['aria-selected'] === true,
    );
    expect((ticked?.props as Record<string, string>)['data-palette-item']).toBe('post-post2');
    (rows[0]?.props as { onClick: () => void }).onClick();
    expect(picked.map((i) => i.id)).toEqual(['post-post1']);
  });

  it('ticks keep tick order; single pick replaces; a second tap clears', () => {
    const a = wsHit('post', 1);
    const b = wsHit('post', 2);
    const multi = togglePicked(togglePicked(new Map(), 'b', b, true), 'a', a, true);
    expect([...multi.values()]).toEqual([b, a]);
    expect([...togglePicked(multi, 'b', b, true).keys()]).toEqual(['a']);
    const single = togglePicked(togglePicked(new Map(), 'a', a, false), 'b', b, false);
    expect([...single.keys()]).toEqual(['b']);
    expect(togglePicked(single, 'b', b, false).size).toBe(0);
  });

  it('opens over the picker sheet with the pill and a disabled "Send 0", reading nothing', () => {
    spy.clientCalls.length = 0;
    const onPick = vi.fn();
    const tree = CommandPalette({
      ...props,
      pickKinds: ['person', 'chat_group'],
      multi: true,
      verb: 'Send',
      pickLabel: 'Chats',
      onPick,
    });
    const overlay = findAll(tree, 'data-palette-overlay')[0];
    expect((overlay?.props as { className: string }).className).toContain('z-dialog');
    expect((overlay?.props as Record<string, string>)['data-palette-mode']).toBe('pick');
    const all = texts(tree);
    expect(all).toContain('Chats only');
    expect(all).toContain('Send 0');
    expect(all).toContain('Chats show up here.');
    expect(all).not.toContain('Recent');
    const footer = findAll(tree, 'data-palette-pick-footer')[0];
    const button = findAll(footer, 'disabled')[0];
    expect((button?.props as { disabled: boolean }).disabled).toBe(true);
    // Nothing ticked: the footer hands nothing back.
    (button?.props as { onClick: () => void }).onClick();
    expect(onPick).not.toHaveBeenCalled();
    const input = findAll(tree, 'placeholder')[0];
    expect((input?.props as { placeholder: string }).placeholder).toBe('Search chats');
    expect(spy.clientCalls).toEqual([]);
  });

  it('normal mode is unchanged: no pill, no footer, the sheet layer', () => {
    const tree = CommandPalette(props);
    expect(findAll(tree, 'data-palette-pick-pill')).toHaveLength(0);
    expect(findAll(tree, 'data-palette-pick-footer')).toHaveLength(0);
    const overlay = findAll(tree, 'data-palette-overlay')[0];
    expect((overlay?.props as { className: string }).className).toContain('z-sheet');
  });

  it('pick mode reads less: full page, no counts, no chat search (source)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./CommandPalette.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('perKind: full || pickMode ? PER_KIND_FULL : PER_KIND_PREVIEW');
    expect(src).toContain('counts: !full && !pickMode');
    expect(src).toMatch(
      /pickMode\s*\?\s*Promise\.resolve\(\{ ok: true as const, data: \{ hits: \[\], next: null \} \}\)/,
    );
  });
});
