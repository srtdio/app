// @vitest-environment jsdom
// The Bank stays current without a refresh: own writes made elsewhere patch
// the kept page in place (Move to bank from the Plan screen appears, Plan it
// removes), and while the Bank is open its live topic re-reads the page once
// per burst, rows already on screen keeping their objects.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const live = vi.hoisted(() => ({
  subscribe: vi.fn(),
  stop: vi.fn(),
  onChange: null as null | (() => void),
}));
vi.mock('@/lib/plan-tab/bank-live', () => ({
  subscribeBankLive: (_client: unknown, workspaceId: string, onChange: () => void) => {
    live.subscribe(workspaceId);
    live.onChange = onChange;
    return live.stop;
  },
}));

const reads = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('@/lib/chat/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/plans')>();
  return { ...actual, readBankPage: reads.page };
});

import { dispatchPlanChanged, type BankIdea, type BankPage } from '@/lib/chat/plans';
import { bankIdeaMovedIn } from '@/lib/chat/plan-item-bank';
import { peekKept, primeRead, resetSessionReads } from '@/lib/session-read';
import { BANK_FILTER_DEFAULT } from './bank-parts';
import {
  applyBankChange,
  bankKeyOf,
  mergeLivePage,
  useBankData,
  type BankData,
} from './use-bank-data';

function idea(id: string, over: Partial<BankIdea> = {}): BankIdea {
  return {
    id,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    target_date: null,
    last_active_at: '2026-11-01T00:00:00Z',
    starred_at: null,
    archived_at: null,
    show_to_client: false,
    comment_count: 0,
    file_count: 0,
    thumb: null,
    format: null,
    ...over,
  } as BankIdea;
}

const KEY = bankKeyOf('me', 'ws', BANK_FILTER_DEFAULT);
let root: Root | null = null;
let data: BankData | null = null;

function keep(ideas: BankIdea[]): void {
  primeRead<Result<BankPage>>(
    KEY,
    { ok: true, data: { ideas, nextCursor: null } },
    Number.POSITIVE_INFINITY,
  );
}

function Probe(props: { live: boolean }): null {
  data = useBankData({
    workspaceId: 'ws',
    userId: 'me',
    enabled: true,
    filter: BANK_FILTER_DEFAULT,
    live: props.live,
  });
  return null;
}

async function mount(isLive = false): Promise<void> {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Probe live={isLive} />));
}

const ids = (): string[] => (data?.ideas ?? []).map((i) => i.id);

beforeEach(() => {
  resetSessionReads();
  reads.page.mockReset();
  reads.page.mockResolvedValue({ ok: true, data: { ideas: [], nextCursor: null } });
  live.subscribe.mockClear();
  live.stop.mockClear();
  live.onChange = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  data = null;
});

describe('own writes elsewhere patch the kept Bank page, no read', () => {
  it('a Move to bank from the Plan screen appears at the top without a refresh', async () => {
    keep([idea('a'), idea('b')]);
    await mount();
    const before = reads.page.mock.calls.length;
    const moved = bankIdeaMovedIn(
      { ...idea('moved'), plan_id: 'p1', target_date: '2026-11-10' },
      'Week of 9 Nov',
      '2026-11-06T10:00:00Z',
    );
    act(() => dispatchPlanChanged(window, 'p1', { kind: 'in', idea: moved }));
    expect(ids()).toEqual(['moved', 'a', 'b']);
    expect(data?.ideas?.[0]?.came_from_plan_title).toBe('Week of 9 Nov');
    expect(reads.page.mock.calls.length).toBe(before);
    // The kept page holds it too, so a return paints it.
    const kept = peekKept<Result<BankPage>>(KEY);
    expect(kept?.ok === true ? kept.data.ideas.map((i) => i.id) : []).toEqual(['moved', 'a', 'b']);
  });

  it('a Plan it from the Bank removes the idea from the kept page', async () => {
    keep([idea('a'), idea('b')]);
    await mount();
    const before = reads.page.mock.calls.length;
    act(() => dispatchPlanChanged(window, 'p1', { kind: 'out', itemId: 'a' }));
    expect(ids()).toEqual(['b']);
    expect(reads.page.mock.calls.length).toBe(before);
  });

  it('patches the kept page even with no Bank mounted (a return paints it)', async () => {
    keep([idea('a')]);
    await mount();
    act(() => root?.unmount());
    root = null;
    dispatchPlanChanged(window, '', {
      kind: 'flags',
      itemId: 'a',
      flags: { show_to_client: true },
    });
    const kept = peekKept<Result<BankPage>>(KEY);
    expect(kept?.ok === true ? kept.data.ideas[0]?.show_to_client : null).toBe(true);
  });
});

describe('live: the Bank open on the agency side', () => {
  it('subscribes when open, unsubscribes when the chip, panel or table closes', async () => {
    keep([idea('a')]);
    await mount(false);
    expect(live.subscribe).not.toHaveBeenCalled();
    await act(async () => root?.render(<Probe live />));
    expect(live.subscribe).toHaveBeenCalledWith('ws');
    await act(async () => root?.render(<Probe live={false} />));
    expect(live.stop).toHaveBeenCalledTimes(1);
  });

  it('a ping reads the page once and keeps the rows already on screen', async () => {
    const a = idea('a');
    keep([a, idea('b')]);
    await mount(true);
    const before = reads.page.mock.calls.length;
    reads.page.mockResolvedValueOnce({
      ok: true,
      data: { ideas: [idea('new'), idea('a'), idea('b', { title: 'B2' })], nextCursor: null },
    });
    await act(async () => live.onChange?.());
    expect(reads.page.mock.calls.length).toBe(before + 1);
    expect(ids()).toEqual(['new', 'a', 'b']);
    expect(data?.ideas?.[1]).toBe(a);
    expect(data?.ideas?.[2]?.title).toBe('B2');
  });
});

describe('pure parts', () => {
  const f = BANK_FILTER_DEFAULT;
  it('applyBankChange: in, out, flags, never a duplicate, off pages it does not fit', () => {
    const list = [idea('a'), idea('b')];
    expect(applyBankChange(list, { kind: 'in', idea: idea('b') }, f).map((i) => i.id)).toEqual([
      'b',
      'a',
    ]);
    expect(
      applyBankChange(list, { kind: 'in', idea: idea('c') }, { ...f, archived: true }).map(
        (i) => i.id,
      ),
    ).toEqual(['a', 'b']);
    expect(applyBankChange(list, { kind: 'out', itemId: 'a' }, f).map((i) => i.id)).toEqual(['b']);
    const archived = applyBankChange(
      list,
      { kind: 'flags', itemId: 'a', flags: { archived_at: 'now' } },
      f,
    );
    expect(archived.map((i) => i.id)).toEqual(['b']);
  });

  it('mergeLivePage keeps unchanged objects and rows loaded beyond the first page', () => {
    const a = idea('a');
    const shown: BankPage = { ideas: [a, idea('b'), idea('c')], nextCursor: null };
    const fresh: BankPage = { ideas: [idea('a'), idea('b')], nextCursor: null };
    const merged = mergeLivePage(shown, fresh);
    expect(merged.ideas[0]).toBe(a);
    expect(merged.ideas.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
