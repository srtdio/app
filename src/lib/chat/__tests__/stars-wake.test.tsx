// @vitest-environment jsdom
// chat_message_stars on a return to Chat: focus and visibilitychange each
// used to re-read the open chat's stars. Counted on a recording client: one
// read per return, none while one is out, none within 5 s of the last, and a
// catch-up inside that window reads nothing more.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  STARS_RELOAD_GAP_MS,
  createChannelStarsLoader,
  createStarStore,
  useChannelStars,
} from '@/lib/chat/stars';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every from() is one request; awaiting answers no stars. */
function recordingClient(): { db: Client; tables: string[] } {
  const tables: string[] = [];
  const from = (table: string): unknown => {
    tables.push(table);
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'abortSignal']) builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return builder;
  };
  return { db: { from } as unknown as Client, tables };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let refetch: (() => void) | null = null;

const write = async (): Promise<Result<null>> => ({ ok: true, data: null });
const store = createStarStore({ workspaceId: 'ws-1', write });

function Probe(props: { db: Client }) {
  refetch = useChannelStars({ store, channelId: 'c1', db: props.db }).refetch;
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function wake(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('stars: one read per return to Chat', () => {
  it('open reads once; a return reads once; a catch-up inside 5 s reads nothing', async () => {
    const { db, tables } = recordingClient();
    act(() => root?.render(<Probe db={db} />));
    await flush();
    expect(tables).toEqual(['chat_message_stars']);
    // Within 5 s of the open's read: a wake reads nothing.
    wake();
    await flush();
    expect(tables).toHaveLength(1);
    vi.setSystemTime(Date.now() + STARS_RELOAD_GAP_MS);
    wake();
    await flush();
    expect(tables).toHaveLength(2);
    act(() => refetch?.());
    await flush();
    expect(tables).toHaveLength(2);
    vi.setSystemTime(Date.now() + STARS_RELOAD_GAP_MS);
    wake();
    await flush();
    expect(tables).toHaveLength(3);
  });
});

describe('createChannelStarsLoader reload', () => {
  it('skips while a read is out and within the gap; another chat always reads', async () => {
    let at = 0;
    let reads = 0;
    let release = (): void => {};
    const loader = createChannelStarsLoader({
      store: createStarStore({ workspaceId: 'ws-1', write }),
      read: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, data: [] });
        });
      },
      onSettled: () => {},
      current: () => 'c1',
      now: () => at,
    });
    const first = loader.reload('c1');
    void loader.reload('c1');
    expect(reads).toBe(1);
    at = STARS_RELOAD_GAP_MS + 1;
    void loader.reload('c1');
    expect(reads).toBe(1);
    release();
    await first;
    void loader.reload('c1');
    expect(reads).toBe(2);
    void loader.reload('c2');
    expect(reads).toBe(3);
  });
});
