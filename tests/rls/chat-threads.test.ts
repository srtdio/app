// Work-chat threads (20261108090000_chat_threads_unread.sql, applied 8 Nov 2026):
//
//   T1. chat_threads_for_me lists a thread to a member (a chat of 6 or fewer:
//       everyone is in every thread), unread until chat_thread_read_set marks
//       it read; chat_thread_mark_unread turns it unread again.
//   T2. Own rows only: each proc writes the caller's chat_thread_reads row and
//       nobody else's; authenticated cannot read or write the table directly.
//   T3. A workspace member who is not in the chat, and another workspace's
//       user, are refused by all four procs ('not a member of this chat').
//   T4. anon cannot execute any of the four procs and reads no row.
//   T5. chat_mark_unread moves my cursor before a top-level message and
//       recomputes my unread counter.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  createAnonClient,
  insertRow,
  loadRlsEnv,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type ThreadRow = Database['public']['Functions']['chat_threads_for_me']['Returns'][number];

/** A fresh uuid_v7 trace id (48-bit ms timestamp, version 7, RFC 4122 variant). */
function traceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A proc's arguments as one value (each carries p_trace_id). */
function procArgs<T extends Record<string, unknown>>(args: T): T {
  return args;
}

/** ISO timestamp `minutes` before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe.runIf(RLS_SUITE)('chat threads: read points, Mark unread and threads for me', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: alice (owner), bob (shares a DM with alice), carol (member of
  // A, not in alice-bob). Workspace B: olga (owner, not in A).
  let alice: SeededUser;
  let bob: SeededUser;
  let carol: SeededUser;
  let olga: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let dm: string;
  let root: string;
  let reply: string;

  async function seedMessage(
    sender: SeededUser,
    minutes: number,
    rootId?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(adminGeneric, 'chat_messages', {
      id,
      channel_id: dm,
      workspace_id: wsA.id,
      sender_user_id: sender.id,
      body: `thread ${randomSuffix()}`,
      agora_event_id: null,
      created_at: minutesAgo(minutes),
      ...(rootId !== undefined
        ? { reply_to_message_id: rootId, thread_root_message_id: rootId }
        : {}),
    });
    return id;
  }

  async function threadsFor(userId: string): Promise<ThreadRow[]> {
    const res = await clientFor(userId).rpc(
      'chat_threads_for_me',
      procArgs({
        p_channel_id: dm,
        p_trace_id: traceId(),
      }),
    );
    if (res.error) throw new Error(`chat_threads_for_me failed: ${res.error.message}`);
    return (res.data ?? []) as ThreadRow[];
  }

  async function readCount(userId: string): Promise<number> {
    return countWhere(adminGeneric, 'chat_thread_reads', [
      ['user_id', userId],
      ['root_message_id', root],
    ]);
  }

  /** Every proc's error for `client` (null when it ran). */
  async function allErrors(client: Client): Promise<(string | null)[]> {
    const t = traceId();
    const results = await Promise.all([
      client.rpc(
        'chat_thread_read_set',
        procArgs({
          p_channel_id: dm,
          p_root_id: root,
          p_message_id: reply,
          p_trace_id: t,
        }),
      ),
      client.rpc(
        'chat_thread_mark_unread',
        procArgs({
          p_channel_id: dm,
          p_root_id: root,
          p_message_id: reply,
          p_trace_id: t,
        }),
      ),
      client.rpc(
        'chat_mark_unread',
        procArgs({ p_channel_id: dm, p_message_id: root, p_trace_id: t }),
      ),
      client.rpc('chat_threads_for_me', procArgs({ p_channel_id: dm, p_trace_id: t })),
    ]);
    return results.map((r) => r.error?.message ?? null);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);
    alice = await seedUser(env, admin);
    bob = await seedUser(env, admin);
    carol = await seedUser(env, admin);
    olga = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, alice, `Threads A ${alice.email}`);
    wsB = await seedWorkspace(admin, olga, `Threads B ${olga.email}`);
    await seedMember(adminGeneric, wsA, bob, 'agency');
    await seedMember(adminGeneric, wsA, carol, 'agency');
    dm = await seedDmChannel(adminGeneric, wsA.id, alice, bob);
    root = await seedMessage(bob, 10);
    reply = await seedMessage(alice, 5, root);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [alice, bob, carol, olga]);
  });

  it('T1: threads for me lists the thread, unread until read, unread again after Mark unread', async () => {
    const before = (await threadsFor(bob.id)).find((t) => t.root_message_id === root);
    expect(before?.reply_count).toBe(1);
    expect(before?.unread).toBe(true);

    const read = await clientFor(bob.id).rpc(
      'chat_thread_read_set',
      procArgs({
        p_channel_id: dm,
        p_root_id: root,
        p_message_id: reply,
        p_trace_id: traceId(),
      }),
    );
    expect(read.error).toBeNull();
    expect((await threadsFor(bob.id)).find((t) => t.root_message_id === root)?.unread).toBe(false);

    const unread = await clientFor(bob.id).rpc(
      'chat_thread_mark_unread',
      procArgs({
        p_channel_id: dm,
        p_root_id: root,
        p_message_id: reply,
        p_trace_id: traceId(),
      }),
    );
    expect(unread.error).toBeNull();
    expect((await threadsFor(bob.id)).find((t) => t.root_message_id === root)?.unread).toBe(true);
    // My own reply is never unread to me.
    expect((await threadsFor(alice.id)).find((t) => t.root_message_id === root)?.unread).toBe(
      false,
    );
  });

  it('T2: own rows only; no direct table access for authenticated', async () => {
    expect(await readCount(bob.id)).toBe(1);
    expect(await readCount(alice.id)).toBe(0);
    const bobClient = asGeneric(clientFor(bob.id));
    expect(await visibleRowCount(bobClient, 'chat_thread_reads', [['user_id', bob.id]])).toBe(0);
    const write = await clientFor(alice.id)
      .from('chat_thread_reads')
      .insert({
        root_message_id: root,
        user_id: alice.id,
        channel_id: dm,
        workspace_id: wsA.id,
        last_read_at: minutesAgo(1),
      });
    expect(write.error).not.toBeNull();
    expect(await readCount(alice.id)).toBe(0);
  });

  it('T3: a non-member of the chat and another workspace are refused by every proc', async () => {
    for (const user of [carol, olga]) {
      const errors = await allErrors(clientFor(user.id));
      for (const error of errors) expect(error).toContain('not a member of this chat');
      expect(await readCount(user.id)).toBe(0);
    }
  });

  it('T4: anon cannot execute any proc and reads nothing', async () => {
    const anon: Client = createAnonClient(loadRlsEnv());
    const errors = await allErrors(anon);
    for (const error of errors) expect(error).not.toBeNull();
    const rows = await anon.from('chat_thread_reads').select('root_message_id').limit(1);
    expect(rows.error !== null || (rows.data ?? []).length === 0).toBe(true);
  });

  it('T5: chat_mark_unread recomputes my counter from that message on', async () => {
    const res = await clientFor(alice.id).rpc(
      'chat_mark_unread',
      procArgs({
        p_channel_id: dm,
        p_message_id: root,
        p_trace_id: traceId(),
      }),
    );
    expect(res.error).toBeNull();
    const counter = await adminGeneric
      .from('chat_unread_counters')
      .select('unread')
      .eq('channel_id', dm)
      .eq('user_id', alice.id);
    expect(counter.error).toBeNull();
    // bob's root counts; alice's own reply does not.
    expect((counter.data as { unread: number }[] | null)?.[0]?.unread).toBe(1);
  });
});
