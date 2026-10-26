// The chat open's people reads: names and picker rows come from the shared
// workspace members cache once it holds a fresh, good read (no users or
// workspace_members request), only ids it cannot answer are read, a cold cache
// loads the members ONCE (shared by the names, the pickers and the next open;
// never the cache's background warm as well), and the two group_members asks
// of one open share one request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

interface Query {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

const ME = 'u-me';
const ANA = 'u-ana';
const BEN = 'u-ben';
const GONE = 'u-gone';
const STRANGER = 'u-stranger';
const WS = 'ws-1';

const MEMBER_ROWS = [
  { user_id: ME, workspace_id: WS, role: 'owner', active: true, removed_at: null },
  { user_id: ANA, workspace_id: WS, role: 'client', active: true, removed_at: null },
  { user_id: BEN, workspace_id: WS, role: 'editor', active: true, removed_at: null },
  { user_id: GONE, workspace_id: WS, role: 'editor', active: false, removed_at: '2026-10-01' },
];

const USERS = [ME, ANA, BEN, GONE, STRANGER].map((id) => ({
  id,
  display_name: `Name ${id}`,
  avatar_url: null,
  username: id,
}));

/** A recording PostgREST-ish client over the fixture tables. */
function recordingClient(): { client: Client; queries: Query[]; release: () => void } {
  const queries: Query[] = [];
  // Group reads hold until released, so a second ask lands while one runs.
  let releaseGroup: () => void = () => {};
  const groupGate = new Promise<void>((resolve) => {
    releaseGroup = resolve;
  });
  const answer = async (query: Query): Promise<{ data: unknown; error: null }> => {
    const inIds = query.calls.find((c) => c.method === 'in')?.args[1] as string[] | undefined;
    const wanted = (id: string): boolean => inIds === undefined || inIds.includes(id);
    if (query.table === 'users') return { data: USERS.filter((u) => wanted(u.id)), error: null };
    if (query.table === 'workspace_members') {
      const activeOnly = query.calls.some((c) => c.method === 'eq' && c.args[0] === 'active');
      return {
        data: MEMBER_ROWS.filter(
          (r) => wanted(r.user_id) && (!activeOnly || (r.active && r.removed_at === null)),
        ),
        error: null,
      };
    }
    if (query.table === 'group_members') {
      await groupGate;
      return { data: [{ user_id: ANA }, { user_id: BEN }], error: null };
    }
    return { data: [], error: null };
  };
  const from = (table: string): unknown => {
    const query: Query = { table, calls: [] };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'order', 'abortSignal']) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      answer(query).then(resolve, reject);
    return builder;
  };
  return { client: { from } as unknown as Client, queries, release: () => releaseGroup() };
}

// The app's client, which the shared members cache reads through: it hands
// each from() to this test's recorder.
const app = vi.hoisted(() => ({
  queries: [] as Array<{ table: string }>,
  from: null as ((table: string) => unknown) | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => app.from?.(table) },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  MEMBERS_STALE_MS,
  ensureWorkspaceMembers,
  peekWorkspaceMembers,
  resetWorkspaceMembersCache,
} from '@/lib/workspace-members';
import {
  approverNamesFromMembers,
  readChatMembersShared,
  readGroupMemberIdsShared,
  readMentionProfilesShared,
  resetGroupMemberReads,
  startChatMembers,
} from '@/lib/chat/open-members';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

function tables(queries: readonly { table: string }[]): string[] {
  return queries.map((q) => q.table).sort();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Warm the shared cache through the app client, then forget its requests. */
async function warm(): Promise<void> {
  ensureWorkspaceMembers(ME, WS);
  await settle();
  expect(peekWorkspaceMembers(ME, WS)).not.toBeNull();
  app.queries.length = 0;
}

beforeEach(() => {
  const rec = recordingClient();
  const recorded = rec.client as unknown as { from: (table: string) => unknown };
  app.from = (table) => recorded.from(table);
  app.queries = rec.queries;
  resetWorkspaceMembersCache();
  resetGroupMemberReads();
  resetSessionReads();
});

afterEach(() => {
  vi.useRealTimers();
  resetWorkspaceMembersCache();
  resetSessionReads();
});

describe('names on chat open', () => {
  it('a warm members cache answers every sender and mention: no request', async () => {
    await warm();
    const { client, queries } = recordingClient();
    const result = await readMentionProfilesShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, BEN, GONE],
    });
    expect(queries).toHaveLength(0);
    expect(app.queries).toHaveLength(0);
    expect(result.ok && result.data.map((p) => [p.userId, p.member])).toEqual([
      [ANA, true],
      [BEN, true],
      // A removed member keeps their name and reads as former.
      [GONE, false],
    ]);
  });

  it('only ids the cache cannot answer are read, in one batched read', async () => {
    await warm();
    const { client, queries } = recordingClient();
    const result = await readMentionProfilesShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, STRANGER],
    });
    expect(tables(queries)).toEqual(['users', 'workspace_members']);
    for (const q of queries) {
      expect(q.calls.find((c) => c.method === 'in')?.args[1]).toEqual([STRANGER]);
    }
    expect(result.ok && result.data.map((p) => [p.userId, p.member])).toEqual([
      [ANA, true],
      [STRANGER, false],
    ]);
  });

  it('a cold cache loads the members once and the next open reads nothing', async () => {
    const { client, queries } = recordingClient();
    const result = await readMentionProfilesShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, BEN],
    });
    expect(result.ok && result.data.map((p) => [p.userId, p.member])).toEqual([
      [ANA, true],
      [BEN, true],
    ]);
    // One members read and one profiles read: the load the open shares.
    expect(tables(queries)).toEqual(['users', 'workspace_members']);
    await settle();
    // No second, background members read on the app client.
    expect(app.queries).toHaveLength(0);
    const next = recordingClient();
    await readMentionProfilesShared(next.client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, BEN],
    });
    expect(next.queries).toHaveLength(0);
    expect(app.queries).toHaveLength(0);
  });

  it('a cache older than MEMBERS_STALE_MS is not served', async () => {
    await warm();
    expect(peekWorkspaceMembers(ME, WS, Date.now() + MEMBERS_STALE_MS + 1)).toBeNull();
    // Another user never gets this user's members.
    expect(peekWorkspaceMembers('u-other', WS)).toBeNull();
  });
});

describe('cold open: one members read', () => {
  it('the names and the picker rows of one open join the same load', async () => {
    const { client, queries } = recordingClient();
    const [names, picker] = await Promise.all([
      readMentionProfilesShared(client, { userId: ME, workspaceId: WS, userIds: [ANA, BEN] }),
      readChatMembersShared(client, { userId: ME, workspaceId: WS, userIds: [ANA, BEN, GONE] }),
    ]);
    expect(names.ok && picker.ok).toBe(true);
    // One workspace_members read and one users read in all, never one per caller.
    expect(tables(queries)).toEqual(['users', 'workspace_members']);
    await settle();
    expect(app.queries).toHaveLength(0);
  });

  it("the tap's load is joined by the open (no duplicate background read)", async () => {
    const { client, queries } = recordingClient();
    const started = startChatMembers(client, ME, WS);
    const result = await readMentionProfilesShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA],
    });
    await started;
    expect(result.ok).toBe(true);
    expect(tables(queries)).toEqual(['users', 'workspace_members']);
    expect(app.queries).toHaveLength(0);
  });

  it('past the window the members are not served: it loads again, once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
    const first = recordingClient();
    await readMentionProfilesShared(first.client, { userId: ME, workspaceId: WS, userIds: [ANA] });
    expect(tables(first.queries)).toEqual(['users', 'workspace_members']);
    vi.setSystemTime(new Date(Date.now() + MEMBERS_STALE_MS + READ_FRESH_MS));
    const later = recordingClient();
    const [names, picker] = await Promise.all([
      readMentionProfilesShared(later.client, { userId: ME, workspaceId: WS, userIds: [ANA] }),
      readChatMembersShared(later.client, { userId: ME, workspaceId: WS, userIds: [ANA] }),
    ]);
    expect(names.ok && picker.ok).toBe(true);
    // Loaded (never the old answer), and exactly one members read for both callers.
    expect(tables(later.queries)).toEqual(['users', 'workspace_members']);
    await settle();
    expect(app.queries).toHaveLength(0);
  });
});

describe('mention picker rows on chat open', () => {
  it('a warm cache gives the current members with their roles: no request', async () => {
    await warm();
    const { client, queries } = recordingClient();
    const result = await readChatMembersShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, BEN, GONE],
    });
    expect(queries).toHaveLength(0);
    // A removed member is never offered, as readChatMembers leaves them out.
    expect(result.ok && result.data.map((m) => [m.userId, m.role])).toEqual([
      [ANA, 'client'],
      [BEN, 'editor'],
    ]);
  });

  it('a cold cache reads users and memberships as before', async () => {
    const { client, queries } = recordingClient();
    const result = await readChatMembersShared(client, {
      userId: ME,
      workspaceId: WS,
      userIds: [ANA, GONE],
    });
    expect(tables(queries)).toEqual(['users', 'workspace_members']);
    expect(result.ok && result.data.map((m) => m.userId)).toEqual([ANA]);
  });
});

describe('post card approver names', () => {
  it('come from a warm cache with their roles, or null so the card reads', async () => {
    expect(approverNamesFromMembers(ME, WS, [ANA])).toBeNull();
    await warm();
    const held = approverNamesFromMembers(ME, WS, [ANA, GONE]);
    expect(held?.profiles.map((p) => p.displayName)).toEqual([`Name ${ANA}`, `Name ${GONE}`]);
    expect(held !== null ? [...held.roles] : []).toEqual([
      [ANA, 'client'],
      [GONE, 'editor'],
    ]);
    expect(approverNamesFromMembers(ME, WS, [STRANGER])).toBeNull();
  });
});

describe('group member ids on chat open', () => {
  it('two asks while one runs share one group_members request; a later ask reads again', async () => {
    const { client, queries, release } = recordingClient();
    const first = readGroupMemberIdsShared(client, { groupId: 'g-1' });
    const second = readGroupMemberIdsShared(client, { groupId: 'g-1' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.ok && a.data).toEqual([ANA, BEN]);
    expect(tables(queries)).toEqual(['group_members']);
    await readGroupMemberIdsShared(client, { groupId: 'g-1' });
    expect(tables(queries)).toEqual(['group_members', 'group_members']);
  });

  it("a caller's abort ends only its own wait", async () => {
    const { client, queries, release } = recordingClient();
    const controller = new AbortController();
    const aborted = readGroupMemberIdsShared(client, {
      groupId: 'g-2',
      signal: controller.signal,
    });
    const kept = readGroupMemberIdsShared(client, { groupId: 'g-2' });
    controller.abort();
    expect((await aborted).ok).toBe(false);
    release();
    expect((await kept).ok).toBe(true);
    expect(tables(queries)).toEqual(['group_members']);
  });
});
