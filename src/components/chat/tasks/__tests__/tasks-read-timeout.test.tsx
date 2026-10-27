// @vitest-environment jsdom
// The task read is bounded: a hung chat_tasks or chat_task_events read lands
// as failed at READ_TIMEOUT_MS (today's failure path: loaded, read failed),
// so loaded never stays false and nothing waits on it forever.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { useChatTasks, type UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let latest: UseChatTasks | null = null;

/** A query builder whose every chain returns itself and whose await never settles. */
function hungBuilder(signals: AbortSignal[]): unknown {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'gt', 'lt', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  builder.abortSignal = (signal: AbortSignal) => {
    signals.push(signal);
    return builder;
  };
  builder.then = () => new Promise(() => {});
  return builder;
}

/** chat_tasks hangs (or both tables do); chat_task_events answers [] otherwise. */
function client(opts: { hangEvents: boolean }, signals: AbortSignal[]): Client {
  const from = (table: string): unknown => {
    if (table === 'chat_tasks' || opts.hangEvents) return hungBuilder(signals);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'gt', 'lt', 'order', 'limit', 'abortSignal']) {
      builder[method] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return builder;
  };
  return { from, rpc: () => new Promise(() => {}) } as unknown as Client;
}

function Probe(props: { db: Client }): ReactElement {
  const [profiles] = useState(() => new Map());
  latest = useChatTasks({
    channelId: 'c-hung',
    currentUserId: 'u1',
    target: null,
    profiles,
    db: props.db,
  });
  return <span />;
}

function show(db: Client): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Probe db={db} />));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Both tables answer [] after `ms` (a slow read inside the deadline). */
function slowClient(ms: number): Client {
  const from = (): unknown => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'gt', 'lt', 'order', 'limit', 'abortSignal']) {
      builder[method] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      new Promise((done) => setTimeout(() => done({ data: [], error: null }), ms)).then(resolve);
    return builder;
  };
  return { from, rpc: () => new Promise(() => {}) } as unknown as Client;
}

describe('task read timeout', () => {
  it('a read inside the deadline lands as today: the lines slot in once it does', async () => {
    show(slowClient(300));
    // Pending: the thread paints its rows meanwhile (tasks are off the hold).
    expect(latest?.loaded).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(latest?.loaded).toBe(true);
    expect(latest?.loadState).toBe('ready');
  });

  it('a hung list read resolves as failed at READ_TIMEOUT_MS', async () => {
    const signals: AbortSignal[] = [];
    show(client({ hangEvents: false }, signals));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    });
    expect(latest?.loaded).toBe(false);
    expect(latest?.loadState).toBe('loading');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(latest?.loaded).toBe(true);
    expect(latest?.loadState).toBe('failed');
    // The read is cancelled on the wire, not just ignored.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('both reads hung: still one failure at READ_TIMEOUT_MS, and rows are covered', async () => {
    show(client({ hangEvents: true }, []));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    });
    expect(latest?.loaded).toBe(true);
    expect(latest?.loadState).toBe('failed');
    // Failure path: coveredFromMs -Infinity, so no row waits on task lines.
    expect(latest?.covers(0)).toBe(true);
  });
});
