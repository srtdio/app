// Catch up threads (20261108120000_catch_up_threads.sql, applied 8 Nov 2026):
//
//   C1. The first reply on a card root writes one system/thread_started inbox
//       entry for each chat member except the sender and the mentioned, with
//       kind, card_kind, card_id, thread_root_id and message_id.
//   C2. A second reply on the same root writes no thread_started entry.
//   C3. A mention in a thread reply carries thread_root_id in its payload (and
//       the mentioned member gets no thread_started for that reply).
//   C4. inbox_mark_unread_ids only touches the caller's rows.
//
// Seeding goes through the service role (packages/test-utils/rls.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../packages/schemas/src/supabase.generated';

const CATCH_UP_SUITE = process.env.CATCH_UP_SUITE === '1';

type Client = SupabaseClient<Database>;
type SendArgs = Database['public']['Functions']['chat_message_send']['Args'];

/** A fresh uuid_v7 trace id. */
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

interface EntryRow {
  id: string;
  user_id: string;
  event_type: string;
  read_at: string | null;
  payload: Json;
}

describe.runIf(CATCH_UP_SUITE)('catch up: thread entries and mark unread', () => {
  let admin: Client;
  let g: GenericClient;
  // Workspace A: alice (owner) and bob share a DM; carol is in A, not in the DM.
  let alice: SeededUser;
  let bob: SeededUser;
  let carol: SeededUser;
  let wsA: SeededWorkspace;
  let dm: string;
  const postId = crypto.randomUUID();

  async function seedRoot(sharedPost: string | null): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(g, 'chat_messages', {
      id,
      channel_id: dm,
      workspace_id: wsA.id,
      sender_user_id: alice.id,
      body: `root ${randomSuffix()}`,
      shared_post_ids: sharedPost !== null ? [sharedPost] : null,
      agora_event_id: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    return id;
  }

  async function reply(sender: SeededUser, rootId: string, mentions?: string[]): Promise<string> {
    const id = crypto.randomUUID();
    const args: SendArgs = {
      p_id: id,
      p_channel_id: dm,
      p_trace_id: traceId(),
      p_body: `reply ${randomSuffix()}`,
      p_reply_to_message_id: rootId,
      ...(mentions !== undefined ? { p_mentions: mentions } : {}),
    };
    const res = await clientFor(sender.id).rpc('chat_message_send', args);
    if (res.error) throw new Error(`chat_message_send failed: ${res.error.message}`);
    return id;
  }

  async function entriesFor(rootId: string): Promise<EntryRow[]> {
    const res = await admin
      .from('inbox_entries')
      .select('id, user_id, event_type, read_at, payload')
      .eq('workspace_id', wsA.id)
      .eq('payload->>thread_root_id', rootId);
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as EntryRow[];
  }

  const kindOf = (row: EntryRow): unknown =>
    typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
      ? row.payload.kind
      : undefined;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    alice = await seedUser(env, admin);
    bob = await seedUser(env, admin);
    carol = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, alice, `Catch up A ${alice.email}`);
    await seedMember(g, wsA, bob, 'agency');
    await seedMember(g, wsA, carol, 'agency');
    dm = await seedDmChannel(g, wsA.id, alice, bob);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [alice, bob, carol]);
  });

  it('C1: the first reply on a card root tells chat members, except the sender', async () => {
    const root = await seedRoot(postId);
    const first = await reply(bob, root);
    const started = (await entriesFor(root)).filter((r) => kindOf(r) === 'thread_started');
    expect(started.map((r) => r.user_id)).toEqual([alice.id]);
    const row = started[0];
    expect(row?.event_type).toBe('system');
    expect(row?.payload).toMatchObject({
      kind: 'thread_started',
      card_kind: 'post',
      card_id: postId,
      thread_root_id: root,
      message_id: first,
    });
    // carol is in the workspace, not in the chat: nothing for her.
    expect(started.some((r) => r.user_id === carol.id)).toBe(false);
  });

  it('C2: a second reply on the same root writes no thread_started', async () => {
    const root = await seedRoot(postId);
    await reply(bob, root);
    await reply(alice, root);
    await reply(bob, root);
    const started = (await entriesFor(root)).filter((r) => kindOf(r) === 'thread_started');
    expect(started).toHaveLength(1);
  });

  it('a root without a card writes no thread_started', async () => {
    const root = await seedRoot(null);
    await reply(bob, root);
    const started = (await entriesFor(root)).filter((r) => kindOf(r) === 'thread_started');
    expect(started).toHaveLength(0);
  });

  it('C3: a mention in a thread carries thread_root_id; the mentioned get no thread_started', async () => {
    const root = await seedRoot(postId);
    const id = await reply(bob, root, [alice.id]);
    const rows = await entriesFor(root);
    const mention = rows.find((r) => r.event_type === 'mention' && r.user_id === alice.id);
    expect(mention?.payload).toMatchObject({ message_id: id, thread_root_id: root });
    expect(rows.filter((r) => kindOf(r) === 'thread_started')).toHaveLength(0);
  });

  it("C4: inbox_mark_unread_ids touches only the caller's rows", async () => {
    const root = await seedRoot(postId);
    await reply(bob, root, [alice.id]);
    const [mine] = (await entriesFor(root)).filter((r) => r.user_id === alice.id);
    expect(mine).toBeDefined();
    const id = mine?.id ?? '';
    const read = await clientFor(alice.id).rpc(
      'inbox_mark_read_ids',
      procArgs({
        p_workspace_id: wsA.id,
        p_ids: [id],
        p_trace_id: traceId(),
      }),
    );
    expect(read.error).toBeNull();
    // bob cannot put alice's entry back to unread.
    const other = await clientFor(bob.id).rpc(
      'inbox_mark_unread_ids',
      procArgs({
        p_workspace_id: wsA.id,
        p_ids: [id],
        p_trace_id: traceId(),
      }),
    );
    expect(other.error).toBeNull();
    const still = await admin.from('inbox_entries').select('read_at').eq('id', id).single();
    expect(still.data?.read_at).not.toBeNull();
    // alice can.
    const own = await clientFor(alice.id).rpc(
      'inbox_mark_unread_ids',
      procArgs({
        p_workspace_id: wsA.id,
        p_ids: [id],
        p_trace_id: traceId(),
      }),
    );
    expect(own.error).toBeNull();
    const back = await admin.from('inbox_entries').select('read_at').eq('id', id).single();
    expect(back.data?.read_at).toBeNull();
    // An empty list is refused.
    const empty = await clientFor(alice.id).rpc(
      'inbox_mark_unread_ids',
      procArgs({
        p_workspace_id: wsA.id,
        p_ids: [],
        p_trace_id: traceId(),
      }),
    );
    expect(empty.error?.message).toContain('invalid_payload');
  });
});
