// @vitest-environment jsdom
// Threads sheet roots read (Thread polish 1): rows read "Thread / Message"
// forever when (a) the threads list changed while the roots read was in flight
// (the effect cleanup dropped the answer, the ids stayed marked asked) or
// (b) the read failed (never asked again). Both now fill in; the read is
// still ONE batched call per pass.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadForMe } from '@/lib/chat/thread-signals';
import type { ThreadMessage } from '@/lib/chat/thread';

vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));

const load = vi.fn();
vi.mock('@/lib/chat/history', () => ({
  loadMessagesByIds: (...args: unknown[]) => load(...args) as unknown,
}));
vi.mock('@/lib/chat/thread', async (orig) => {
  const actual = await orig<typeof import('@/lib/chat/thread')>();
  return {
    ...actual,
    rowToThreadMessage: (row: { id: string; body: string }) =>
      ({
        id: row.id,
        body: row.body,
        senderUserId: 'u2',
        deleted: false,
        attachments: [],
      }) as unknown as ThreadMessage,
  };
});

const { ThreadsSheet } = await import('@/components/chat/ThreadsSheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  load.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function thread(rootId: string, at: string): ThreadForMe {
  return {
    rootId,
    replyCount: 2,
    lastReplyAt: at,
    lastReplyId: `${rootId}-r`,
    lastReplySender: 'u2',
    lastReplyBody: 'reply',
    unread: false,
  };
}

function render(threads: ThreadForMe[]): void {
  act(() =>
    root?.render(
      <ThreadsSheet
        open
        onClose={() => undefined}
        threads={threads}
        loaded={new Map()}
        currentUserId="u1"
        nameOf={() => 'Asha'}
        photoOf={() => undefined}
        onOpenThread={() => undefined}
      />,
    ),
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Threads sheet roots read', () => {
  it('keeps the answer when the threads list changes while the read is in flight', async () => {
    const pending = deferred<unknown>();
    load.mockReturnValueOnce(pending.promise);
    const t1 = thread('m1', '2026-11-11T10:00:00Z');
    render([t1]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[1]).toEqual(['m1']);
    // The list changes (a new reply lands) before the answer arrives.
    render([{ ...t1, replyCount: 3 }]);
    await act(async () => {
      pending.resolve({ ok: true, data: [{ id: 'm1', body: 'Root text' }] });
      await pending.promise;
    });
    expect(host.textContent).toContain('Root text');
    expect(host.textContent).not.toContain('Message');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next pass after a failed read', async () => {
    load.mockResolvedValueOnce({ ok: false, error: { message: 'boom' } });
    const t1 = thread('m1', '2026-11-11T10:00:00Z');
    render([t1]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Message');
    load.mockResolvedValueOnce({ ok: true, data: [{ id: 'm1', body: 'Root text' }] });
    render([{ ...t1, replyCount: 3 }]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[1]).toEqual(['m1']);
    expect(host.textContent).toContain('Root text');
  });
});
