// Chat message hides, Delete for me (20261107120000_chat_message_hides.sql):
//
//   T1. A member hides a message in their chat and reads the row back; a
//       repeat call adds no second row.
//   T2. The caller reads back only their own rows; a second member of the
//       same chat sees none of the first user's rows and still reads the
//       message itself.
//   T3. Another workspace's user and a non-member of the chat get
//       'message not found' and no row is written.
//   T4. More than 100 ids raises 'too many messages'; 0 ids is a no-op.
//   T5. authenticated cannot INSERT, UPDATE or DELETE chat_message_hides
//       directly; anon cannot SELECT and cannot execute chat_messages_hide.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  authInsert,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  createAnonClient,
  deleteRowCount,
  insertRow,
  loadRlsEnv,
  ownReadCount,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  updateRowCount,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type HideArgs = Database['public']['Functions']['chat_messages_hide']['Args'];

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

function hideArgs(messageIds: string[]): HideArgs {
  return { p_message_ids: messageIds, p_trace_id: traceId() };
}

/** chat_messages_hide as `userId`; returns the error message or null. */
async function hide(userId: string, messageIds: string[]): Promise<string | null> {
  const res = await clientFor(userId).rpc('chat_messages_hide', hideArgs(messageIds));
  return res.error?.message ?? null;
}

/** ISO timestamp `minutes` before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe.runIf(RLS_SUITE)('chat message hides: own rows and proc gates', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: alice (owner, does the hiding), bob (shares a DM with alice),
  // carol (member of A, not in alice-bob). Workspace B: olga (owner, not in A).
  let alice: SeededUser;
  let bob: SeededUser;
  let carol: SeededUser;
  let olga: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let dmBob: string;
  let aliceClient: GenericClient;
  let bobClient: GenericClient;

  /** Seed one live chat_messages row through the service role and return its id. */
  async function seedMessage(
    channelId: string,
    workspaceId: string,
    sender: SeededUser,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(adminGeneric, 'chat_messages', {
      id,
      channel_id: channelId,
      workspace_id: workspaceId,
      sender_user_id: sender.id,
      body: `hide ${randomSuffix()}`,
      agora_event_id: null,
      created_at: minutesAgo(1),
    });
    return id;
  }

  async function hideCount(userId: string, messageId: string): Promise<number> {
    return countWhere(adminGeneric, 'chat_message_hides', [
      ['user_id', userId],
      ['message_id', messageId],
    ]);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    alice = await seedUser(env, admin);
    bob = await seedUser(env, admin);
    carol = await seedUser(env, admin);
    olga = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, alice, `Hides A ${alice.email}`);
    wsB = await seedWorkspace(admin, olga, `Hides B ${olga.email}`);
    await seedMember(adminGeneric, wsA, bob, 'agency');
    await seedMember(adminGeneric, wsA, carol, 'agency');

    dmBob = await seedDmChannel(adminGeneric, wsA.id, alice, bob);

    aliceClient = asGeneric(clientFor(alice.id));
    bobClient = asGeneric(clientFor(bob.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [alice, bob, carol, olga]);
  });

  it('T1: a member hides a message in their chat; a repeat call is a no-op', async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    expect(await hide(alice.id, [msg])).toBeNull();
    expect(
      await ownReadCount(aliceClient, 'chat_message_hides', [
        ['user_id', alice.id],
        ['message_id', msg],
        ['channel_id', dmBob],
        ['workspace_id', wsA.id],
      ]),
    ).toBe(1);

    expect(await hide(alice.id, [msg, msg])).toBeNull();
    expect(await hideCount(alice.id, msg)).toBe(1);
  });

  it('T2: reads back only own rows; a second member sees none of them', async () => {
    const mine = await seedMessage(dmBob, wsA.id, alice);
    const theirs = await seedMessage(dmBob, wsA.id, alice);
    expect(await hide(alice.id, [mine])).toBeNull();
    expect(await hide(bob.id, [theirs])).toBeNull();

    // Ground truth: both rows exist.
    expect(await hideCount(alice.id, mine)).toBe(1);
    expect(await hideCount(bob.id, theirs)).toBe(1);

    // Each reads only their own row.
    expect(await visibleRowCount(aliceClient, 'chat_message_hides', [['user_id', bob.id]])).toBe(0);
    expect(await visibleRowCount(aliceClient, 'chat_message_hides', [['message_id', theirs]])).toBe(
      0,
    );
    expect(await visibleRowCount(bobClient, 'chat_message_hides', [['user_id', alice.id]])).toBe(0);
    expect(await visibleRowCount(bobClient, 'chat_message_hides', [['message_id', mine]])).toBe(0);
    expect(await ownReadCount(bobClient, 'chat_message_hides', [['message_id', theirs]])).toBe(1);

    // Delete for me never hides the message from anyone else.
    expect(await ownReadCount(bobClient, 'chat_messages', [['id', mine]])).toBe(1);
  });

  it("T3: a non-member and another workspace's user get 'message not found'", async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    expect(await hide(carol.id, [msg])).toBe('message not found');
    expect(await hideCount(carol.id, msg)).toBe(0);
    expect(await hide(olga.id, [msg])).toBe('message not found');
    expect(await hideCount(olga.id, msg)).toBe(0);

    // One unknown id among known ones fails the whole call.
    expect(await hide(alice.id, [msg, crypto.randomUUID()])).toBe('message not found');
    expect(await hideCount(alice.id, msg)).toBe(0);
  });

  it('T4: more than 100 ids raises; 0 ids is a no-op', async () => {
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect(await hide(alice.id, ids)).toBe('too many messages');
    expect(await hide(alice.id, [])).toBeNull();
  });

  it('T5: no direct writes for authenticated; anon reads nothing and cannot execute', async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    expect(await hide(alice.id, [msg])).toBeNull();
    const match: [string, string][] = [
      ['user_id', alice.id],
      ['message_id', msg],
    ];

    const other = await seedMessage(dmBob, wsA.id, bob);
    const ins = await authInsert(aliceClient, 'chat_message_hides', {
      user_id: alice.id,
      message_id: other,
      channel_id: dmBob,
      workspace_id: wsA.id,
    });
    expect(ins.ok && ins.count > 0).toBe(false);
    expect(await hideCount(alice.id, other)).toBe(0);

    expect(
      await updateRowCount(aliceClient, 'chat_message_hides', match, {
        hidden_at: minutesAgo(60),
      }),
    ).toBe(0);
    expect(await deleteRowCount(aliceClient, 'chat_message_hides', match)).toBe(0);
    expect(await countWhere(adminGeneric, 'chat_message_hides', match)).toBe(1);

    const env = loadRlsEnv();
    const anon: Client = createAnonClient(env);
    const anonRead = await anon.from('chat_message_hides').select('message_id').limit(1);
    expect(anonRead.error !== null || (anonRead.data ?? []).length === 0).toBe(true);
    expect(await visibleRowCount(asGeneric(anon), 'chat_message_hides', match)).toBe(0);
    const anonHide = await anon.rpc('chat_messages_hide', hideArgs([other]));
    expect(anonHide.error).not.toBeNull();
    expect(await hideCount(alice.id, other)).toBe(0);
  });
});
