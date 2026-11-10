// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({
  calls: [] as string[][],
  delayMs: 0,
  rows: [] as { targetId: string; userId: string; emoji: string; createdAt: string }[],
}));
const writes = vi.hoisted(() => ({ calls: [] as unknown[][], ok: true }));
const toasts = vi.hoisted(() => ({ shown: [] as { title: string; tone?: string }[] }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));
vi.mock('@/lib/reactions/reads', () => ({
  readReactions: (_c: unknown, _k: unknown, ids: string[]) => {
    reads.calls.push(ids);
    const answer = { ok: true, data: reads.rows.filter((r) => ids.includes(r.targetId)) };
    return new Promise((r) => setTimeout(() => r(answer), reads.delayMs));
  },
}));
vi.mock('@/lib/reactions/writes', () => ({
  writeReaction: (...args: unknown[]) => {
    writes.calls.push(args);
    return Promise.resolve(writes.ok ? { ok: true } : { ok: false, message: 'refused' });
  },
}));
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (t: { title: string; tone?: string }) => {
      toasts.shown.push(t);
      return 'id';
    },
    dismiss: () => {},
  }),
}));

import { errorText } from '@/lib/error-copy';
import { idsToRead, useReactions, type ReactionsApi } from '@/lib/reactions/use-reactions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let api: ReactionsApi | null = null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function Probe(props: { ids: string[]; epoch: number }) {
  api = useReactions({ kind: 'comment', ids: props.ids, epoch: props.epoch, me: 'me' });
  return null;
}

async function render(ids: string[], epoch = 1): Promise<void> {
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(<Probe ids={ids} epoch={epoch} />));
  await flush();
}

beforeEach(() => {
  reads.calls = [];
  reads.delayMs = 0;
  reads.rows = [{ targetId: 'c1', userId: 'u', emoji: '👍', createdAt: '2026-11-09T10:00:00Z' }];
  writes.calls = [];
  writes.ok = true;
  toasts.shown = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
});

describe('useReactions', () => {
  it('one batched read per page; a new page reads only its new ids; a refresh re-reads all', async () => {
    await render(['c1', 'c2']);
    expect(reads.calls).toEqual([['c1', 'c2']]);
    await render(['c1', 'c2', 'c3']);
    expect(reads.calls).toEqual([['c1', 'c2'], ['c3']]);
    await render(['c1', 'c2', 'c3'], 2);
    expect(reads.calls[2]).toEqual(['c1', 'c2', 'c3']);
  });

  it('a re-render that changes the id order mid-read never drops the read', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    reads.delayMs = 30;
    await act(async () => root?.render(<Probe ids={['c2', 'c1']} epoch={1} />));
    await act(async () => root?.render(<Probe ids={['c1', 'c2']} epoch={1} />));
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    expect(reads.calls).toEqual([['c2', 'c1']]);
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('toggle adds optimistically, a second tap removes', async () => {
    await render(['c1']);
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    await act(async () => api?.toggle('c1', '👍'));
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(writes.calls[0]?.[3]).toBe('add');
    await act(async () => api?.toggle('c1', '👍'));
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(writes.calls[1]?.[3]).toBe('remove');
  });

  it('a refused write rolls back and shows the standard error toast', async () => {
    writes.ok = false;
    await render(['c1']);
    await act(async () => api?.toggle('c1', '❤️'));
    await flush();
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(toasts.shown).toEqual([{ title: errorText('add the reaction', null), tone: 'error' }]);
  });

  it('a drawer pick adds (never removes)', async () => {
    reads.rows = [{ targetId: 'c1', userId: 'me', emoji: '👍', createdAt: 't' }];
    await render(['c1']);
    await act(async () => api?.pick('c1', '👍'));
    expect(writes.calls[0]?.[3]).toBe('add');
    expect(api?.of('c1')).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('idsToRead: the unread ids only, unless a full refresh', () => {
    expect(idsToRead(['a', 'b', 'a'], new Set(['a']), false)).toEqual(['b']);
    expect(idsToRead(['a', 'b'], new Set(['a']), true)).toEqual(['a', 'b']);
  });
});
