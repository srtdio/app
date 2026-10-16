import { describe, expect, it, vi } from 'vitest';
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
  PaletteBody,
  paletteSections,
  type PaletteItem,
  type PaletteSection,
  type ResultGroup,
} from '@/components/shell/CommandPalette';
import type { SearchHit } from '@/lib/chat/search';
import type { PaletteSearchState, WorkspaceHit } from '@/lib/search/workspace-search';

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

function wsHit(kind: WorkspaceHit['kind'], n: number, extra: Partial<WorkspaceHit> = {}) {
  return {
    kind,
    id: `${kind}${n}`,
    entityType: kind === 'brief' ? 'brief' : 'post',
    entityId: `e${n}`,
    entityNumber: n,
    title: `Diwali ${kind} ${n}`,
    snippet: 'festive lights',
    createdAt: '2026-10-16T11:00:00Z',
    ...extra,
  } satisfies WorkspaceHit;
}

const chatHit: SearchHit = {
  id: 'm1',
  channelId: 'group__w__g',
  senderUserId: 'u1',
  body: 'diwali plan is ready',
  createdAt: '2026-10-16T11:30:00Z',
  mediaLine: '',
};

function ready(query: string, workspace: WorkspaceHit[], chat: SearchHit[]): PaletteSearchState {
  return { query, status: 'ready', workspace, chat };
}

function sections(
  query: string,
  search: PaletteSearchState,
  expanded: ReadonlySet<ResultGroup> = new Set(),
): PaletteSection[] {
  return paletteSections({
    query,
    search,
    expanded,
    workspaceKey: 'GBL',
    nameOf: (id) => (id === 'u1' ? 'Asha' : undefined),
    nowMs: NOW,
    timeZone: 'UTC',
  });
}

function body(
  query: string,
  search: PaletteSearchState,
  onPick: (item: PaletteItem) => void = () => {},
) {
  return PaletteBody({
    query,
    search,
    sections: sections(query, search),
    active: 0,
    onHover: () => {},
    onPick,
    onRetry: () => {},
  });
}

describe('CommandPalette', () => {
  const props = { open: true, onClose: () => {}, workspaceId: 'w', workspaceKey: 'GBL' };

  it('lists the Go to commands and no New post / New brief actions', () => {
    const all = texts(CommandPalette(props));
    expect(all).toContain('Pipeline');
    expect(all).toContain('Briefs');
    expect(all).not.toContain('New post');
    expect(all).not.toContain('New brief');
    expect(all).not.toContain('Actions');
  });

  it('renders as a full-screen sheet on phones and has a 44px Cancel', () => {
    const tree = CommandPalette(props);
    const dialog = findAll(tree, 'role')[0];
    expect((dialog?.props as { className: string }).className).toContain('h-full');
    expect(texts(tree)).toContain('Cancel');
  });

  it('filters Go to by label', () => {
    const s = sections('brie', { query: '', status: 'idle', workspace: [], chat: [] });
    expect(s.map((x) => x.label)).toEqual(['Go to']);
    expect(s[0]?.items.map((i) => i.id)).toEqual(['goto-briefs']);
  });

  it('renders groups in order Posts, Briefs, Comments, Chat', () => {
    const search = ready(
      'diwali',
      [wsHit('comment', 3), wsHit('brief', 2), wsHit('post', 1)],
      [chatHit],
    );
    const groups = findAll(body('diwali', search), 'data-palette-group').map(
      (el) => (el.props as Record<string, string>)['data-palette-group'],
    );
    expect(groups).toEqual(['Posts', 'Briefs', 'Comments', 'Chat']);
  });

  it('caps a group at 5 with Show all, expanding to 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => wsHit('post', i + 1));
    const search = ready('diwali', many, []);
    const collapsed = sections('diwali', search).find((s) => s.label === 'Posts');
    expect(collapsed?.items.filter((i) => i.type === 'result')).toHaveLength(5);
    expect(collapsed?.items.at(-1)).toMatchObject({ type: 'more', group: 'Posts', count: 20 });
    expect(texts(body('diwali', search))).toContain('Show all (20)');
    const open = sections('diwali', search, new Set(['Posts'])).find((s) => s.label === 'Posts');
    expect(open?.items).toHaveLength(20);
    expect(open?.items.some((i) => i.type === 'more')).toBe(false);
  });

  it('each kind opens the right path', () => {
    const search = ready(
      'diwali',
      [
        wsHit('post', 1),
        wsHit('brief', 2),
        wsHit('comment', 3, { entityType: 'post' }),
        wsHit('comment', 4, { entityType: 'brief' }),
      ],
      [chatHit],
    );
    const picked: string[] = [];
    const tree = body('diwali', search, (item) => {
      if (item.type !== 'more') picked.push(item.path);
    });
    for (const el of findAll(tree, 'data-palette-item')) {
      const id = (el.props as Record<string, string>)['data-palette-item'] ?? '';
      if (id.startsWith('goto-')) continue;
      (el.props as { onClick: () => void }).onClick();
    }
    expect(picked).toEqual([
      '/p/gbl-1',
      '/b/gbl-2',
      '/p/gbl-3',
      '/b/gbl-4',
      '/chat?channel=group__w__g&message=m1',
    ]);
  });

  it('shows the chat sender, highlights matched words, and a relative time', () => {
    const tree = body('diwali', ready('diwali', [], [chatHit]));
    const all = texts(tree);
    expect(all).toContain('Asha');
    expect(all).toContain('30m');
    const bold = findAll(tree, 'data-search-match').map((el) => texts(el).join(''));
    expect(bold).toContain('diwali');
  });

  it('ignores a stale response for an older query', () => {
    const stale = ready('diw', [wsHit('post', 1)], []);
    expect(sections('diwali', stale).map((s) => s.label)).toEqual([]);
    expect(findAll(body('diwali', stale), 'data-palette-state')).toHaveLength(1);
  });

  it('shows loading, empty and error states', () => {
    const loading: PaletteSearchState = {
      query: 'diwali',
      status: 'loading',
      workspace: [],
      chat: [],
    };
    expect(texts(body('diwali', loading))).toContain('Searching…');

    expect(texts(body('diwali', ready('diwali', [], [])))).toContain(emptyCopy('diwali'));
    expect(emptyCopy(' diwali ')).toBe('No results for "diwali"');

    let retried = 0;
    const errTree = PaletteBody({
      query: 'diwali',
      search: { query: 'diwali', status: 'error', workspace: [], chat: [] },
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
});
