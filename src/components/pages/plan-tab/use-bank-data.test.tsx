// @vitest-environment jsdom
// The Bank's data: a page of max(12, the screen's fill count) with a keyset cursor (starred first), Load
// more appends without duplicates, and a return paints the kept page on its
// first frame (no read before paint).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';
import {
  BANK_PAGE_SIZE,
  bankKeysetFilter,
  bankPageOf,
  type BankIdea,
  type BankPage,
  type PlanItemRow,
} from '@/lib/chat/plans';
import { primeRead, resetSessionReads } from '@/lib/session-read';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { BANK_FILTER_DEFAULT } from './bank-parts';
import {
  bankKeyOf,
  bankSetArgs,
  mergeBankPages,
  useBankData,
  withFlags,
  type BankData,
} from './use-bank-data';
import { getFillCount } from '@/lib/use-fill-count';

function row(id: string, at: string, starred = false): PlanItemRow {
  return {
    id,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: at,
    updated_at: at,
    target_date: null,
    last_active_at: at,
    starred_at: starred ? at : null,
    archived_at: null,
    show_to_client: false,
  };
}

function idea(id: string): BankIdea {
  return {
    ...row(id, '2026-11-01T00:00:00Z'),
    comment_count: 0,
    file_count: 0,
    thumb: null,
    format: null,
  };
}

const rows = (prefix: string, n: number, starred = false): PlanItemRow[] =>
  Array.from({ length: n }, (_, i) =>
    row(`${prefix}${i}`, `2026-10-${String(28 - i).padStart(2, '0')}T00:00:00Z`, starred),
  );

describe('a page and its cursor', () => {
  it('fills a first page with starred ideas, then the rest', () => {
    const rest = rows('r', BANK_PAGE_SIZE + 1);
    const page = bankPageOf('active', null, rows('s', 2, true), rest);
    expect(page.rows).toHaveLength(BANK_PAGE_SIZE);
    expect(page.rows.slice(0, 2).map((r) => r.id)).toEqual(['s0', 's1']);
    // The page's last row is the rest group's (BANK_PAGE_SIZE - 2)th.
    const last = rest[BANK_PAGE_SIZE - 3]!;
    expect(page.nextCursor).toEqual({
      starred: false,
      after: { key: last.last_active_at, id: `r${BANK_PAGE_SIZE - 3}` },
    });
  });

  it('stays in the starred group while it has more than a page', () => {
    const page = bankPageOf('active', null, rows('s', BANK_PAGE_SIZE + 1, true), []);
    expect(page.nextCursor?.starred).toBe(true);
    expect(page.rows.every((r) => r.starred_at !== null)).toBe(true);
  });

  it('starts the rest from its start when the starred group filled the page exactly', () => {
    const page = bankPageOf('active', null, rows('s', BANK_PAGE_SIZE, true), rows('r', 3));
    expect(page.nextCursor).toEqual({ starred: false, after: null });
  });

  it('ends with no cursor when nothing remains', () => {
    expect(bankPageOf('active', null, [], rows('r', 3)).nextCursor).toBeNull();
  });

  it('reads strictly after the cursor, ties by id', () => {
    expect(bankKeysetFilter('active', { key: 'K', id: 'I' })).toBe(
      'last_active_at.lt."K",and(last_active_at.eq."K",id.lt."I")',
    );
    expect(bankKeysetFilter('name', { key: 'K', id: 'I' })).toBe(
      'title.gt."K",and(title.eq."K",id.gt."I")',
    );
  });

  it('appends a next page without duplicates', () => {
    const shown: BankPage = {
      ideas: [idea('a'), idea('b')],
      nextCursor: null,
    };
    const next: BankPage = { ideas: [idea('b'), idea('c')], nextCursor: null };
    const merged = mergeBankPages(shown, next);
    expect(merged.ideas.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('flags', () => {
  it('sends every flag, one changed', () => {
    const base = idea('a');
    expect(bankSetArgs({ ...base, show_to_client: true }, { starred: true }, 't')).toEqual({
      p_item_id: 'a',
      p_show_to_client: true,
      p_archived: false,
      p_starred: true,
      p_trace_id: 't',
    });
    expect(withFlags(base, { archived: true }, 'NOW').archived_at).toBe('NOW');
    expect(
      withFlags({ ...base, starred_at: 'x' }, { starred: false }, 'NOW').starred_at,
    ).toBeNull();
  });
});

describe('kept paint', () => {
  it('paints the kept first page on the first frame', () => {
    resetSessionReads();
    const key = bankKeyOf('me', 'ws', BANK_FILTER_DEFAULT);
    const page: BankPage = {
      ideas: [idea('kept')],
      nextCursor: null,
    };
    primeRead<Result<BankPage>>(key, { ok: true, data: page }, Number.POSITIVE_INFINITY);
    const frames: Array<BankData['load']['status']> = [];
    function Probe(): null {
      const data = useBankData({
        workspaceId: 'ws',
        userId: 'me',
        enabled: true,
        filter: BANK_FILTER_DEFAULT,
      });
      frames.push(data.load.status);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    expect(frames[0]).toBe('ready');
    act(() => root.unmount());
  });

  it('the shown ideas are the kept page; the Bank has no search of its own', () => {
    resetSessionReads();
    const key = bankKeyOf('me', 'ws', BANK_FILTER_DEFAULT);
    const page: BankPage = { ideas: [idea('kept')], nextCursor: null };
    primeRead<Result<BankPage>>(key, { ok: true, data: page }, Number.POSITIVE_INFINITY);
    let seen: BankData | null = null;
    function Probe(): null {
      seen = useBankData({
        workspaceId: 'ws',
        userId: 'me',
        enabled: true,
        filter: BANK_FILTER_DEFAULT,
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    const data = seen as BankData | null;
    expect(data?.ideas?.map((i) => i.id)).toEqual(['kept']);
    expect(data !== null && 'search' in data).toBe(false);
    act(() => root.unmount());
  });
});

describe('Bank page size fills the screen', () => {
  it('the page limit is max(12, the fill count), read once per app load', () => {
    expect(BANK_PAGE_SIZE).toBe(Math.max(12, getFillCount()));
    expect(BANK_PAGE_SIZE).toBeGreaterThanOrEqual(12);
  });

  it('a page holds exactly BANK_PAGE_SIZE ideas and reads one extra to know more remain', () => {
    const many = Array.from({ length: BANK_PAGE_SIZE + 1 }, (_unused, i) => ({
      id: `r${String(i).padStart(3, '0')}`,
      last_active_at: `2026-01-01T00:00:${String(59 - (i % 60)).padStart(2, '0')}Z`,
    }));
    const page = bankPageOf('active', null, [], many as never);
    expect(page.rows).toHaveLength(BANK_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
  });
});
