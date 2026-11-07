// @vitest-environment jsdom
// The "covered" perf mark: once the task events every loaded message needs are
// read (the thread's ensureEventsSince ask is covered), useChatTasks drops
// TASKS_COVERED_MARK. The e2e waits on it to know the first page's task lines
// are in, instead of a wall-clock budget. No ask, no mark.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const marks = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/perf-marks', () => ({
  mark: (name: string) => {
    marks.push(name);
  },
}));

import {
  TASKS_COVERED_MARK,
  useChatTasks,
  type UseChatTasks,
} from '@/components/chat/tasks/useChatTasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let latest: UseChatTasks | null = null;

/** Both tables answer [] once `gate` resolves (a short events page: all read). */
function client(gate: Promise<void>): Client {
  const from = (): unknown => {
    const builder: Record<string, unknown> = {};
    for (const method of [
      'select',
      'eq',
      'is',
      'in',
      'gt',
      'lt',
      'order',
      'limit',
      'abortSignal',
    ]) {
      builder[method] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      gate.then(() => ({ data: [], error: null })).then(resolve);
    return builder;
  };
  return { from, rpc: () => new Promise(() => {}) } as unknown as Client;
}

// The hook remembers each chat's list at module level: one channel per test.
let seq = 0;

function Probe(props: { db: Client; channelId: string }): ReactElement {
  const [profiles] = useState(() => new Map());
  latest = useChatTasks({
    channelId: props.channelId,
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
  seq += 1;
  act(() => root?.render(<Probe db={db} channelId={`c-covered-${seq}`} />));
}

/** Let every pending read and its state update land (a few macrotask turns). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

const covered = (): number => marks.filter((m) => m === TASKS_COVERED_MARK).length;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  marks.length = 0;
  document.body.innerHTML = '';
});

describe('TASKS_COVERED_MARK', () => {
  it('no ask from the thread: the list loads with no covered mark', async () => {
    show(client(Promise.resolve()));
    await settle();
    expect(latest?.loaded).toBe(true);
    expect(marks).toContain('chat:tasks:loaded');
    expect(covered()).toBe(0);
  });

  it('an ask the loaded page covers drops one mark', async () => {
    show(client(Promise.resolve()));
    await settle();
    expect(covered()).toBe(0);
    act(() => latest?.ensureEventsSince('2026-11-01T00:00:00.000Z'));
    await settle();
    expect(covered()).toBe(1);
  });

  it('a repeat ask for the same moment drops no second mark; an older ask drops one', async () => {
    show(client(Promise.resolve()));
    await settle();
    act(() => latest?.ensureEventsSince('2026-11-01T00:00:00.000Z'));
    await settle();
    expect(covered()).toBe(1);
    // The thread re-asks whenever its first message object changes.
    act(() => latest?.ensureEventsSince('2026-11-01T00:00:00.000Z'));
    await settle();
    expect(covered()).toBe(1);
    // An older page asks further back.
    act(() => latest?.ensureEventsSince('2026-10-01T00:00:00.000Z'));
    await settle();
    expect(covered()).toBe(2);
  });

  it('an ask made before the list lands is marked once the load covers it, not before', async () => {
    let open: () => void = () => {};
    show(client(new Promise<void>((done) => (open = done))));
    act(() => latest?.ensureEventsSince('2026-11-01T00:00:00.000Z'));
    expect(latest?.loaded).toBe(false);
    expect(covered()).toBe(0);
    open();
    await settle();
    expect(latest?.loaded).toBe(true);
    expect(covered()).toBe(1);
  });
});
