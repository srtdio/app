import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  CommandPalette,
  emptyCopy,
  namesNeeded,
  PaletteBody,
  paletteSections,
  resolvePaletteNames,
  type PaletteItem,
  type PaletteSection,
  type ResultGroup,
} from '@/components/shell/CommandPalette';
import { rememberMentionNames, resetMentionNames } from '@/lib/chat/mentions';
import type { SearchHit } from '@/lib/chat/search';
import type { RecentEntry } from '@/lib/recent-items';
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
    expect((dialog?.props as { className: string }).className).toContain('sm:max-w-[560px]');
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
      { path: '/plans/plan6?q=diwali' },
      { path: '/plans/plan1?q=diwali&at=plan_item7' },
      { path: '/chat?channel=group__w__g&task=task8&q=diwali' },
      { path: '/chat?channel=group__w__g&q=diwali' },
      { path: '/chat?channel=group__w__g&message=m1&q=diwali' },
    ]);
  });

  it('shows the chat sender, highlights matched words, and a relative time', () => {
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
    expect(emptyCopy(' diwali ')).toBe('No results for "diwali"');

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
      expect((el.props as { className: string }).className).toContain('min-h-[44px]');
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
    // The keyboard-selected row carries the accent tint; every row tints while pressed.
    const classes = findAll(tree, 'data-palette-item').map(
      (el) => (el.props as { className: string }).className,
    );
    expect(classes[1]).toContain('bg-accent-soft');
    expect(classes[0]).not.toMatch(/(^|\s)bg-accent-soft/);
    for (const cls of classes) expect(cls).toContain('active:bg-accent-soft');
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
