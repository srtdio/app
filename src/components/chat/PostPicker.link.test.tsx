// @vitest-environment jsdom
// The post picker's link mode (a plan concept's "Link a post"): the same-day
// section first, then other dates newest first; single select (accent row and
// check); "Link this post" with nothing picked shows "Pick a post first.";
// search across every post (no stage filter, drafts included); an empty
// search is NoResults with Clear search. Plus the regression guard: the post
// and draft modes keep their titles, Done footer, reads and stage filters.

import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Read {
  select: unknown[];
  filters: Array<{ method: string; args: unknown[] }>;
}

type Reply = (read: Read) => { data: unknown; count?: number };

const db = vi.hoisted(() => {
  const state: { reads: Read[]; reply: Reply } = { reads: [], reply: () => ({ data: [] }) };
  return state;
});

vi.mock('@/lib/supabase', () => {
  const from = () => {
    const read: Read = { select: [], filters: [] };
    db.reads.push(read);
    const b: Record<string, unknown> = {};
    b.select = (...args: unknown[]) => {
      read.select = args;
      return b;
    };
    for (const method of ['eq', 'neq', 'is', 'gte', 'lt', 'or', 'order', 'limit', 'in']) {
      b[method] = (...args: unknown[]) => {
        read.filters.push({ method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ error: null, count: null, ...db.reply(read) }).then(resolve);
    return b;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'ws-1',
    workspaceKey: 'GBL',
    workspaces: [{ id: 'ws-1', timezone: 'Asia/Kolkata' }],
  }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u-1' } } }),
}));
vi.mock('@/lib/chat/viewer-role', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/viewer-role')>()),
  fetchMemberRole: async () => 'agency',
}));
vi.mock('@/lib/chat/post-covers', () => ({
  usePostCovers: () => () => null,
  requestPostCovers: async () => undefined,
  coverFor: () => null,
}));
// The Sheet renders its title, body and footer inline (no portal or motion).
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (p: { open: boolean; title: string; children: ReactNode; footer?: ReactNode }) =>
    p.open ? (
      <div data-sheet-title={p.title}>
        {p.children}
        <div data-sheet-footer="">{p.footer}</div>
      </div>
    ) : null,
}));

import { PostPicker, LINK_CONFIRM, LINK_PICK_FIRST_HINT } from '@/components/chat/PostPicker';
import { searchStageFilter, pickerReads } from '@/components/chat/post-picker';
import type { PostCardFields } from '@srtdio/posts';
import type { PostPickerPageRow } from '../../../packages/posts/src/reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, over: Partial<PostPickerPageRow>): PostPickerPageRow {
  return {
    id,
    title: id,
    platform: 'linkedin',
    format: 'text',
    stage: 'review',
    number: 1,
    caption: null,
    target_date: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

// 6 Nov is the concept's day; posts are dated 12:00 in the workspace zone.
const SAME = row('Farmers', {
  target_date: '2026-11-06T06:30:00Z',
  created_at: '2026-10-20T00:00:00Z',
});
const NEWER = row('Jaggery unit', {
  stage: 'draft',
  target_date: '2026-11-12T06:30:00Z',
  created_at: '2026-10-30T00:00:00Z',
});
const OLDER = row('Bhai Dooj', {
  stage: 'approved',
  target_date: '2026-10-23T06:30:00Z',
  created_at: '2026-10-10T00:00:00Z',
});

const hasFilter = (read: Read, method: string, column: string): boolean =>
  read.filters.some((f) => f.method === method && f.args[0] === column);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  db.reads = [];
  db.reply = (read) => {
    if (hasFilter(read, 'gte', 'target_date')) return { data: [SAME] };
    const search = read.filters.find((f) => f.method === 'or');
    if (search !== undefined) {
      const text = String(search.args[0]);
      return { data: text.includes('Bhai') ? [OLDER] : [], count: text.includes('Bhai') ? 1 : 0 };
    }
    // The newest page (every stage): newest first, the same-day post among them.
    return { data: [NEWER, SAME, OLDER] };
  };
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

interface LinkProps {
  selectedId?: string | null;
  onSelect?: (post: PostCardFields) => void;
  onConfirm?: () => void;
}

async function renderLink(props: LinkProps = {}): Promise<void> {
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <PostPicker
        open
        mode="link"
        onClose={() => undefined}
        selected={[]}
        onToggle={() => undefined}
        selectedBriefs={[]}
        onToggleBrief={() => undefined}
        linkDay="2026-11-06"
        linkSelectedId={props.selectedId ?? null}
        onLinkSelect={props.onSelect ?? (() => undefined)}
        onLinkConfirm={props.onConfirm ?? (() => undefined)}
      />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function rowButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
}

function text(el: Element | null): string {
  return el?.textContent ?? '';
}

async function typeSearch(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
}

describe('link mode', () => {
  it('titles the sheet "Link a post" and lists the same day first, then other dates newest first', async () => {
    await renderLink();
    expect(document.querySelector('[data-sheet-title]')?.getAttribute('data-sheet-title')).toBe(
      'Link a post',
    );
    const sections = [...document.querySelectorAll('[data-section]')];
    expect(sections.map((s) => s.getAttribute('data-section'))).toEqual(['day', 'other']);
    expect(text(sections[0]?.querySelector('li') ?? null)).toBe('Fri 6 Nov');
    expect(text(sections[1]?.querySelector('li') ?? null)).toBe('Other dates');
    // The same-day post is not listed twice; other dates keep newest first, drafts included.
    expect(rowButtons().map((b) => text(b.querySelector('.text-lg')))).toEqual([
      'Farmers',
      'Jaggery unit',
      'Bhai Dooj',
    ]);
    // Two reads in parallel: the day's posts and the newest page, no stage filter on either.
    const reads = db.reads.filter((r) => hasFilter(r, 'eq', 'workspace_id'));
    expect(reads).toHaveLength(2);
    expect(reads.some((r) => hasFilter(r, 'eq', 'stage') || hasFilter(r, 'neq', 'stage'))).toBe(
      false,
    );
  });

  it('a tap picks one post: accent row and check; the pick is single', async () => {
    const onSelect = vi.fn();
    await renderLink({ selectedId: 'Bhai Dooj', onSelect });
    const pressed = rowButtons().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(text(pressed[0] ?? null)).toContain('Bhai Dooj');
    expect(pressed[0]?.className).toContain('lit-selected');
    expect(pressed[0]?.querySelector('svg')).not.toBeNull();
    await act(async () => {
      rowButtons()[0]?.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((onSelect.mock.calls[0]?.[0] as PostCardFields).id).toBe('Farmers');
  });

  it('"Link this post" with nothing picked shows "Pick a post first."; with a pick it confirms', async () => {
    const onConfirm = vi.fn();
    await renderLink({ onConfirm });
    const confirm = (): HTMLButtonElement =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-picker-link-confirm]')][0]!;
    expect(text(confirm())).toBe(LINK_CONFIRM);
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(text(document.querySelector('[role="alert"]'))).toBe(LINK_PICK_FIRST_HINT);
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    await renderLink({ selectedId: 'Farmers', onConfirm });
    await act(async () => confirm().click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('search reaches every post on any date; an empty search is NoResults with Clear search', async () => {
    await renderLink();
    await typeSearch('Bhai');
    expect(rowButtons().map((b) => text(b.querySelector('.text-lg')))).toEqual(['Bhai Dooj']);
    const search = db.reads.find((r) => r.filters.some((f) => f.method === 'or'));
    expect(search !== undefined && hasFilter(search, 'neq', 'stage')).toBe(false);
    expect(search !== undefined && hasFilter(search, 'eq', 'stage')).toBe(false);
    await typeSearch('laddoo');
    expect(document.body.textContent).toContain('Try another word for "laddoo".');
    const clear = [...document.querySelectorAll('button')].find((b) => text(b) === 'Clear search');
    expect(clear).toBeDefined();
    expect(document.body.textContent?.toLowerCase()).not.toContain('no matches');
    expect(document.body.textContent?.toLowerCase()).not.toContain('empty');
  });
});

describe('the post and draft modes are unchanged', () => {
  it('keep their titles, the Done footer and their stage filters', async () => {
    for (const [mode, title] of [
      ['posts', 'Share a post'],
      ['drafts', 'Share a draft'],
    ] as const) {
      await act(async () => {
        root = createRoot(host!);
        root.render(
          <PostPicker
            open
            mode={mode}
            onClose={() => undefined}
            selected={[]}
            onToggle={() => undefined}
            selectedBriefs={[]}
            onToggleBrief={() => undefined}
            channelHasClient={false}
          />,
        );
      });
      expect(document.querySelector('[data-sheet-title]')?.getAttribute('data-sheet-title')).toBe(
        title,
      );
      const footer = document.querySelector('[data-sheet-footer]');
      expect(text(footer)).toBe('Done');
      expect(footer?.querySelector('[data-picker-link-confirm]')).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
    expect(searchStageFilter('posts', true)).toEqual({ excludeStage: 'draft' });
    expect(searchStageFilter('drafts', true)).toEqual({ stage: 'draft' });
    expect(searchStageFilter('inline', false)).toEqual({ excludeStage: 'draft' });
    expect(searchStageFilter('link', false)).toEqual({});
    expect(pickerReads('posts')).toEqual({ posts: true, briefs: false });
    expect(pickerReads('link')).toEqual({ posts: true, briefs: false });
  });
});
