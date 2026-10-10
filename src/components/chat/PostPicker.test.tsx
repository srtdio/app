import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Stub the supabase client so importing the picker never builds a real one. The
// views are hookless and rendered to static markup (node env, no DOM); the
// loaders take a recording client, so query counts are asserted directly.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// The inline picker renders the stateful component; its contexts are stubbed.
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u-1' } } }),
}));

import type { Client } from '@srtdio/rpc';
import {
  InlinePickerPanel,
  PickerSkeleton,
  PostPicker,
  PostSectionsView,
  SearchResultsView,
  loadPickerSections,
  loadSearchPage,
  briefsLoadError,
  POSTS_LOAD_FAILED,
  type PostRowContext,
} from '@/components/chat/PostPicker';
import { isAgencySide } from '@/components/pages/pcs/roles';
import { WorkspaceMemberSchema } from '@srtdio/schemas';
import type { PostPickerPageRow } from '../../../packages/posts/src/reads';

const WS = 'ws-1';
const roles: string[] = WorkspaceMemberSchema.shape.role.options;
const agency = roles.find((r) => isAgencySide(r)) ?? null;
const nonAgency = roles.find((r) => !isAgencySide(r)) ?? null;

function row(n: number, over: Partial<PostPickerPageRow> = {}): PostPickerPageRow {
  return {
    id: `p${n}`,
    title: `Post ${n}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'review',
    number: n,
    caption: null,
    target_date: null,
    created_at: `2026-09-${String(10 + (n % 10)).padStart(2, '0')}T00:00:00Z`,
    ...over,
  };
}

interface Read {
  select: unknown[];
  filters: Array<{ method: string; args: unknown[] }>;
}

// One recording builder per from('posts'): the reply is chosen from the read's
// own filters, so each section read gets its own rows.
function makeClient(reply: (read: Read) => { data: unknown; count?: number }) {
  const reads: Read[] = [];
  const from = vi.fn(() => {
    const read: Read = { select: [], filters: [] };
    reads.push(read);
    const b: Record<string, unknown> = {};
    b.select = (...args: unknown[]) => {
      read.select = args;
      return b;
    };
    for (const method of ['eq', 'neq', 'is', 'gte', 'lt', 'or', 'order', 'limit']) {
      b[method] = (...args: unknown[]) => {
        read.filters.push({ method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ error: null, count: null, ...reply(read) }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, reads };
}

function stageOf(read: Read): unknown {
  return read.filters.find((f) => f.method === 'eq' && f.args[0] === 'stage')?.args[1];
}

function isHead(read: Read): boolean {
  return (read.select[1] as { head?: boolean } | undefined)?.head === true;
}

const ctx: PostRowContext = {
  selected: [],
  onToggle: () => undefined,
  workspaceKey: 'GBL',
  timeZone: 'UTC',
};

function sectionsClient(older: number) {
  return makeClient((read) => {
    if (isHead(read)) return { data: null, count: older };
    const stage = stageOf(read);
    if (stage === 'review') return { data: [row(1)] };
    if (stage === 'approved') return { data: [row(2, { stage: 'approved' })] };
    if (stage === 'draft') return { data: [row(3, { stage: 'draft' })] };
    if (stage === 'parked') return { data: [row(4, { stage: 'parked' })] };
    if (stage === 'rejected') return { data: [row(5, { stage: 'rejected' })] };
    return { data: [] };
  });
}

describe('loadPickerSections', () => {
  it('posts mode: review, approved (30d), parked, rejected + 1 head count; no draft read', async () => {
    for (const role of [agency, nonAgency]) {
      for (const allowDrafts of [true, false]) {
        const { client, reads } = sectionsClient(212);
        const now = new Date('2026-09-28T00:00:00Z');
        const result = await loadPickerSections(client, {
          workspaceId: WS,
          role,
          now,
          mode: 'posts',
          allowDrafts,
        });
        expect(reads).toHaveLength(5);
        expect(reads.filter(isHead)).toHaveLength(1);
        expect(reads.filter((r) => !isHead(r)).map(stageOf)).toEqual([
          'review',
          'approved',
          'parked',
          'rejected',
        ]);
        expect(reads.some((r) => stageOf(r) === 'draft')).toBe(false);
        const approved = reads.find((r) => stageOf(r) === 'approved' && !isHead(r));
        expect(approved?.filters).toContainEqual({
          method: 'gte',
          args: ['stage_entered_at', '2026-08-29T00:00:00.000Z'],
        });
        expect(result.ok && result.data.sections.map((s) => s.key)).toEqual([
          'review',
          'approved',
          'parked',
          'rejected',
        ]);
        expect(result.ok && result.data.olderApprovedCount).toBe(212);
      }
    }
  });

  it('drafts mode: exactly one read, stage draft, when drafts are allowed', async () => {
    const { client, reads } = sectionsClient(0);
    const result = await loadPickerSections(client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'drafts',
      allowDrafts: true,
    });
    expect(reads).toHaveLength(1);
    expect(stageOf(reads[0] as Read)).toBe('draft');
    expect(result.ok && result.data.sections.map((s) => s.key)).toEqual(['draft']);
  });

  it('drafts mode: zero reads when drafts are not allowed (client viewer or client chat)', async () => {
    for (const role of [agency, nonAgency]) {
      const { client, reads } = sectionsClient(0);
      const result = await loadPickerSections(client, {
        workspaceId: WS,
        role,
        now: new Date(),
        mode: 'drafts',
        allowDrafts: false,
      });
      expect(reads).toHaveLength(0);
      expect(result).toEqual({ ok: true, data: { sections: [], olderApprovedCount: 0 } });
    }
  });

  it('inline: the drafts read only when drafts are allowed', async () => {
    const allowed = sectionsClient(0);
    await loadPickerSections(allowed.client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'inline',
      allowDrafts: true,
    });
    expect(allowed.reads.some((r) => stageOf(r) === 'draft')).toBe(true);
    const barred = sectionsClient(0);
    const result = await loadPickerSections(barred.client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'inline',
      allowDrafts: false,
    });
    expect(barred.reads).toHaveLength(3);
    expect(barred.reads.some((r) => stageOf(r) === 'draft')).toBe(false);
    expect(result.ok && result.data.sections.map((s) => s.key)).toEqual(['review', 'approved']);
  });

  it('F14: a failed read surfaces fixed copy, never the raw error text', async () => {
    const { client } = makeClient(() => ({ data: null, error: { message: 'boom' } }));
    const result = await loadPickerSections(client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'posts',
      allowDrafts: false,
    });
    expect(result).toEqual({ ok: false, message: POSTS_LOAD_FAILED });
    expect(POSTS_LOAD_FAILED).toBe("Couldn't load posts, try again");
  });

  it('F14: a failed search page and a failed briefs read show mapped copy', async () => {
    const { client } = makeClient(() => ({ data: null, error: { message: 'relation boom' } }));
    const page = await loadSearchPage(client, {
      workspaceId: WS,
      mode: 'posts',
      allowDrafts: false,
      query: { text: 'x', number: null },
      cursor: null,
    });
    expect(page).toEqual({ ok: false, message: POSTS_LOAD_FAILED });
    expect(briefsLoadError({ ok: false, error: { message: 'relation boom' } })).toBe(
      "Couldn't load briefs, try again",
    );
    expect(briefsLoadError({ ok: true })).toBeNull();
  });
});

describe('search stage per mode', () => {
  const query = { text: 'holi', number: null };

  it('posts mode: neq stage draft even for an agency viewer with drafts allowed', async () => {
    const { client, reads } = makeClient(() => ({ data: [], count: 0 }));
    await loadSearchPage(client, {
      workspaceId: WS,
      mode: 'posts',
      allowDrafts: true,
      query,
      cursor: null,
    });
    expect(reads[0]?.filters).toContainEqual({ method: 'neq', args: ['stage', 'draft'] });
    expect(reads[0]?.filters.some((f) => f.method === 'eq' && f.args[0] === 'stage')).toBe(false);
  });

  it('drafts mode: eq stage draft only; no read at all when drafts are not allowed', async () => {
    const allowed = makeClient(() => ({ data: [], count: 0 }));
    await loadSearchPage(allowed.client, {
      workspaceId: WS,
      mode: 'drafts',
      allowDrafts: true,
      query,
      cursor: null,
    });
    expect(allowed.reads).toHaveLength(1);
    expect(stageOf(allowed.reads[0] as Read)).toBe('draft');
    const barred = makeClient(() => ({ data: [], count: 0 }));
    const result = await loadSearchPage(barred.client, {
      workspaceId: WS,
      mode: 'drafts',
      allowDrafts: false,
      query,
      cursor: null,
    });
    expect(barred.reads).toHaveLength(0);
    expect(result).toEqual({ ok: true, rows: [], count: 0 });
  });

  it('inline (hash picker): drafts excluded unless allowed (client chat or client viewer)', async () => {
    const barred = makeClient(() => ({ data: [], count: 0 }));
    await loadSearchPage(barred.client, {
      workspaceId: WS,
      mode: 'inline',
      allowDrafts: false,
      query,
      cursor: null,
    });
    expect(barred.reads[0]?.filters).toContainEqual({ method: 'neq', args: ['stage', 'draft'] });
    const allowed = makeClient(() => ({ data: [], count: 0 }));
    await loadSearchPage(allowed.client, {
      workspaceId: WS,
      mode: 'inline',
      allowDrafts: true,
      query,
      cursor: null,
    });
    expect(allowed.reads[0]?.filters.some((f) => f.method === 'neq')).toBe(false);
  });
});

describe('sections render', () => {
  it('renders section headings in order with rows and the footer count', async () => {
    const { client } = sectionsClient(212);
    const result = await loadPickerSections(client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'posts',
      allowDrafts: true,
    });
    if (!result.ok) throw new Error('load failed');
    const html = renderToStaticMarkup(<PostSectionsView data={result.data} {...ctx} />);
    const order = ['Waiting on client', 'Approved in the last 30 days', 'Parked', 'Rejected'].map(
      (label) => html.indexOf(label),
    );
    expect(html).not.toContain('Drafts');
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('GBL-1');
    expect(html).toContain('Post 1');
    expect(html).toContain('212 older approved posts · type a word or number to find one');
  });

  it('omits the footer when there are no older approved posts', async () => {
    const { client } = sectionsClient(0);
    const result = await loadPickerSections(client, {
      workspaceId: WS,
      role: agency,
      now: new Date(),
      mode: 'posts',
      allowDrafts: false,
    });
    if (!result.ok) throw new Error('load failed');
    const html = renderToStaticMarkup(<PostSectionsView data={result.data} {...ctx} />);
    expect(html).not.toContain('older approved');
  });

  it('the loading state is three placeholder rows', () => {
    const html = renderToStaticMarkup(<PickerSkeleton />);
    expect(html.match(/data-skeleton-row/g)).toHaveLength(3);
    expect(html).not.toContain('animate-');
  });
});

describe('search paging', () => {
  it('first page: one read with an exact count; next page: one keyset read, no count', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => row(i + 1));
    const { client, reads } = makeClient((read) =>
      read.filters.filter((f) => f.method === 'or').length === 2
        ? { data: [row(51)] }
        : { data: page1, count: 51 },
    );
    const query = { text: 'GBL-14', number: 14 };
    const first = await loadSearchPage(client, {
      workspaceId: WS,
      mode: 'posts',
      allowDrafts: false,
      query,
      cursor: null,
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.select[1]).toEqual({ count: 'exact' });
    expect(reads[0]?.filters).toContainEqual({ method: 'neq', args: ['stage', 'draft'] });
    expect(first.ok && first.count).toBe(51);

    const last = page1[49];
    if (last === undefined) throw new Error('no rows');
    const next = await loadSearchPage(client, {
      workspaceId: WS,
      mode: 'inline',
      allowDrafts: true,
      query,
      cursor: { createdAt: last.created_at, id: last.id },
    });
    expect(reads).toHaveLength(2);
    expect(reads[1]?.select[1]).toEqual({});
    expect(reads[1]?.filters.some((f) => f.method === 'neq')).toBe(false);
    expect(next.ok && next.rows.map((r) => r.id)).toEqual(['p51']);
  });

  it('renders "<N> matches" and "Load 50 more" with "<shown> of <N>" while more remain', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1));
    const html = renderToStaticMarkup(
      <SearchResultsView
        rows={rows}
        count={120}
        loadingMore={false}
        onLoadMore={() => undefined}
        {...ctx}
      />,
    );
    expect(html).toContain('120 matches');
    expect(html).toContain('Load 50 more');
    expect(html).toContain('50 of 120');
  });

  it('hides "Load 50 more" once every match is shown', () => {
    const html = renderToStaticMarkup(
      <SearchResultsView
        rows={[row(1)]}
        count={1}
        loadingMore={false}
        onLoadMore={() => undefined}
        {...ctx}
      />,
    );
    expect(html).toContain('1 match');
    expect(html).not.toContain('Load 50 more');
  });
});

describe('in this chat', () => {
  it('replaces the stage tag for posts already shared in this chat', () => {
    const rows = [row(1), row(2)];
    const html = renderToStaticMarkup(
      <SearchResultsView
        rows={rows}
        count={2}
        loadingMore={false}
        onLoadMore={() => undefined}
        {...ctx}
        sharedPostIds={new Set(['p1'])}
      />,
    );
    expect(html.match(/in this chat/g)).toHaveLength(1);
  });

  it('shows nothing when the caller passes no shared ids', () => {
    const html = renderToStaticMarkup(
      <SearchResultsView
        rows={[row(1)]}
        count={1}
        loadingMore={false}
        onLoadMore={() => undefined}
        {...ctx}
      />,
    );
    expect(html).not.toContain('in this chat');
  });
});

describe('inline mode (the composer hash picker)', () => {
  function inline(open: boolean, query: string): string {
    return renderToStaticMarkup(
      <PostPicker
        inline
        open={open}
        query={query}
        onClose={() => undefined}
        selected={[]}
        onToggle={() => undefined}
        selectedBriefs={[]}
        onToggleBrief={() => undefined}
      />,
    );
  }

  it('renders the posts list alone in a panel: no sheet, tabs or search box', () => {
    const html = inline(true, '');
    expect(html).toContain('data-post-picker-inline');
    expect(html).toContain('aria-label="Loading posts"');
    expect(html).not.toContain('Share a post or brief');
    expect(html).not.toContain('Briefs');
    expect(html).not.toMatch(/<input\b/);
  });

  it('a controlled query goes straight to search (skeleton until the page lands)', () => {
    const html = inline(true, 'launch');
    expect(html).toContain('data-post-picker-inline');
    expect(html).toContain('aria-label="Loading posts"');
  });

  it('renders nothing while closed', () => {
    expect(inline(false, '')).toBe('');
  });

  it('the panel lays the sections flush (no sheet gutter) and scrolls', () => {
    const el = InlinePickerPanel({ open: true, children: <PickerSkeleton /> });
    const className = (el?.props as { className: string }).className;
    expect(className).toContain('overflow-y-auto');
    expect(className).toContain('[&>ul]:mx-0');
    expect(InlinePickerPanel({ open: false, children: <PickerSkeleton /> })).toBeNull();
    const html = renderToStaticMarkup(
      <InlinePickerPanel open>
        <PostSectionsView
          data={{
            sections: [{ key: 'review', label: 'Waiting on client', rows: [row(1)] }],
            olderApprovedCount: 0,
          }}
          {...ctx}
          sharedPostIds={new Set(['p1'])}
        />
      </InlinePickerPanel>,
    );
    expect(html).toContain('Waiting on client');
    expect(html).toContain('in this chat');
  });
});
