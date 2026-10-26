// @vitest-environment jsdom
// The five workspace-wide reads a chat open makes (open posts list + count,
// current shared plan ids, open briefs list + count) are the workspace's
// shared session reads: opening chat B right after A reads none of them again
// and paints them in B's first frame; older than the window they are not
// painted (B holds and reads, as a cold open); a post or plan change drops
// them and the mounted hooks read once more.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      throw new Error('the app client is never read in this test');
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';
import { useOpenPosts, type UseOpenPosts } from '@/lib/chat/use-open-posts';
import { useStatusCounts, type UseStatusCounts } from '@/lib/chat/use-status-counts';
import { createOpenCache, kickoffChatOpen } from '@/lib/chat/open-cache';
import { joinChatBundle, type ChatBundleDeps } from '@/lib/chat/open-bundle';
import { sharedChatRead } from '@/lib/chat/workspace-reads';
import type { ChatOpenBundle } from '@/lib/chat/history';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT, type PlanBundle } from '@/lib/chat/plans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'u-me';
const WS = 'ws-1';

/** A PostgREST-ish client: every from() is one request, any chain answers empty. */
function recordingClient(): { client: Client; tables: string[] } {
  const tables: string[] = [];
  const answer = { data: [], error: null, count: 0 };
  const from = (table: string): unknown => {
    tables.push(table);
    const builder: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(answer).then(resolve, reject);
          }
          return () => builder;
        },
      },
    );
    return builder;
  };
  return { client: { from } as unknown as Client, tables };
}

function counts(tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (out[t] ?? 0) + 1;
  return out;
}

const noBundles = (): Promise<Result<Map<string, PlanBundle>>> =>
  Promise.resolve({ ok: true, data: new Map() });

interface Frame {
  posts: UseOpenPosts;
  status: UseStatusCounts;
}

let frames: Frame[] = [];

function Probe(props: { channelId: string; client: Client }): ReactElement {
  const posts = useOpenPosts(WS, props.channelId, props.client, {
    userId: ME,
    channelId: props.channelId,
  });
  const status = useStatusCounts({
    workspaceId: WS,
    channelId: props.channelId,
    userId: ME,
    client: props.client,
    readBundles: noBundles,
  });
  frames.push({ posts, status });
  return <span />;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openChat(channelId: string, client: Client): Promise<Frame | undefined> {
  act(() => root?.unmount());
  host?.remove();
  frames = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe channelId={channelId} client={client} />);
  });
  const first = frames[0];
  await settle();
  return first;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
  resetSessionReads();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  frames = [];
  resetSessionReads();
  vi.useRealTimers();
});

describe('chat open: the workspace reads are shared across chats', () => {
  it('A reads the five once; B right after reads none and paints them in its first frame', async () => {
    const { client, tables } = recordingClient();
    await openChat('c-a', client);
    // posts: the list and the head-only count; plans: the ids; briefs: list and count.
    expect(counts(tables)).toEqual({ posts: 2, plans: 1, briefs: 2 });
    tables.length = 0;
    const first = await openChat('c-b', client);
    expect(tables).toEqual([]);
    // No loading frame: the fresh shared answers show at once.
    expect(first?.posts.ready).toBe(true);
    expect(first?.status.briefs.ready).toBe(true);
    expect(first?.status.plans.ready).toBe(true);
  });

  it('older than the window is not painted: B holds, then reads the five again', async () => {
    const { client, tables } = recordingClient();
    await openChat('c-a', client);
    tables.length = 0;
    vi.setSystemTime(new Date(Date.now() + READ_FRESH_MS + 1));
    const first = await openChat('c-b', client);
    expect(first?.posts.ready).toBe(false);
    expect(first?.posts.posts).toBeNull();
    expect(first?.status.briefs.ready).toBe(false);
    expect(counts(tables)).toEqual({ posts: 2, plans: 1, briefs: 2 });
  });

  it('a post change drops them: the mounted chat reads each once more', async () => {
    const { client, tables } = recordingClient();
    await openChat('c-a', client);
    tables.length = 0;
    act(() => {
      window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    });
    await settle();
    expect(counts(tables)).toEqual({ posts: 2, plans: 1, briefs: 2 });
    // And the next chat joins that new read.
    tables.length = 0;
    await openChat('c-b', client);
    expect(tables).toEqual([]);
  });

  it('a plan change drops the ticker reads only', async () => {
    const { client, tables } = recordingClient();
    await openChat('c-a', client);
    tables.length = 0;
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT, { detail: { planId: 'pl1' } }));
    });
    await settle();
    expect(counts(tables)).toEqual({ plans: 1, briefs: 2 });
  });
});

describe('a chat open over its one chat_open_bundle call', () => {
  function bundle(): ChatOpenBundle {
    return {
      serverNow: '2026-10-26T10:00:00.000Z',
      page: { rows: [], hasMore: false },
      quoted: [],
      reactions: [],
      readPositions: { rows: [], times: new Map() },
      replyCounts: new Map(),
      marks: [],
      scheduled: [],
      openPosts: [],
      openPostCount: 4,
      sharedPlanIds: ['p1'],
      openBriefs: [{ id: 'b1', number: 1, title: 'Brief', created_at: '2026-10-25T10:00:00Z' }],
      openBriefCount: 1,
    };
  }

  it('the hooks join the bundle parts: no read of their own, the bundle data shown', async () => {
    const { client, tables } = recordingClient();
    const asked: Array<string | null | undefined> = [];
    const store = createOpenCache();
    const deps: ChatBundleDeps = {
      store,
      read: (input) => {
        asked.push(input.since);
        return Promise.resolve({ ok: true, data: bundle() });
      },
      share: sharedChatRead,
      traceId: () => 'trace-1',
    };
    const key = { userId: ME, workspaceId: WS, channelId: 'c-a' };
    kickoffChatOpen(key, { bundle: (k) => void joinChatBundle(k, { deps }), viewerSide: () => {} }, store);
    await openChat('c-a', client);
    // One bundle call; the hooks' first rounds made no read of their own.
    expect(asked).toEqual([null]);
    expect(counts(tables)).toEqual({});
    const last = frames[frames.length - 1];
    expect(last?.posts.count).toBe(4);
    expect(last?.status.briefs.count).toBe(1);
    expect(last?.status.briefs.rows.map((b) => b.id)).toEqual(['b1']);
  });

  it('a failed bundle fails every part (all or nothing)', async () => {
    const { client } = recordingClient();
    const store = createOpenCache();
    const deps: ChatBundleDeps = {
      store,
      read: () => Promise.resolve({ ok: false, error: { code: 'unknown', message: 'down' } }),
      share: sharedChatRead,
      traceId: () => 'trace-2',
    };
    const key = { userId: ME, workspaceId: WS, channelId: 'c-f' };
    void joinChatBundle(key, { deps });
    // The hooks mount while it is in flight and join it.
    await openChat('c-f', client);
    const marks = await store.join(key, 'marks');
    expect(marks?.ok).toBe(false);
    const scheduled = await store.join(key, 'scheduled');
    expect(scheduled?.ok).toBe(false);
    const last = frames[frames.length - 1];
    expect(last?.status.briefs.failed).toBe(true);
    expect(last?.posts.failed).toBe(true);
  });
});
