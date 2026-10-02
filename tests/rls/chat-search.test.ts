// chat_message_search (20261003100000_chat_message_search.sql): read-only,
// SECURITY INVOKER prefix search over chat_messages, so the
// chat_messages_select_channel_member policy decides what each caller sees.
//
//   T1  a member finds an own-workspace message by full word and by prefix.
//   T2  a workspace member outside the channel gets 0 rows.
//   T3  a user in another workspace gets 0 rows searching this workspace.
//   T4  a message at or before the caller's clear point is not returned.
//   T5  a soft-deleted message is not returned.
//   T6  a multi-word query requires every word.
//   T7  tsquery operator characters, quotes and backslash never raise.
//   T8  queries under 2 or over 100 chars return 0 rows without error.
//   T9  keyset paging on (created_at, id) has no duplicates and no gaps;
//       p_channel_id limits results to one chat.
//   T10 anon cannot execute the function.
//
// Seeding goes through the service role, using the shared helpers in
// packages/test-utils/rls.ts the same way tests/rls/chat.test.ts does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  createAnonClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  partitionTimestamp,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedScaffold,
  seedUser,
  seedWorkspace,
  type Ctx,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type SearchArgs = Database['public']['Functions']['chat_message_search']['Args'];
type SearchRow = Database['public']['Functions']['chat_message_search']['Returns'][number];
type SendArgs = Database['public']['Functions']['chat_message_send']['Args'];
type ClearArgs = Database['public']['Functions']['chat_channel_clear']['Args'];

/** A unique lowercase word per run so searches never collide with other fixtures. */
function token(): string {
  return `tok${randomSuffix()}`;
}

/** ISO timestamp `seconds` after partitionTimestamp (inside a shipped partition). */
function at(seconds: number): string {
  return new Date(Date.parse(partitionTimestamp) + seconds * 1000).toISOString();
}

/** Build chat_message_search args with a fresh trace id, as callRpc() does. */
function searchArgs(
  workspaceId: string,
  query: string,
  extra: { channelId?: string; beforeCreatedAt?: string; beforeId?: string; limit?: number } = {},
): SearchArgs {
  const args: SearchArgs = {
    p_workspace_id: workspaceId,
    p_query: query,
    p_trace_id: generateTraceId(),
  };
  if (extra.channelId !== undefined) args.p_channel_id = extra.channelId;
  if (extra.beforeCreatedAt !== undefined) args.p_before_created_at = extra.beforeCreatedAt;
  if (extra.beforeId !== undefined) args.p_before_id = extra.beforeId;
  if (extra.limit !== undefined) args.p_limit = extra.limit;
  return args;
}

/** Run a search as `client`; throws on an RPC error so callers assert on rows. */
async function search(client: Client, args: SearchArgs): Promise<SearchRow[]> {
  const res = await client.rpc('chat_message_search', args);
  if (res.error) throw new Error(`chat_message_search failed: ${res.error.message}`);
  return res.data ?? [];
}

function ids(rows: readonly SearchRow[]): string[] {
  return rows.map((r) => r.id);
}

/** Seed one chat_messages row through the service role with a chosen body and time. */
async function seedMessage(
  admin: GenericClient,
  channelId: string,
  workspaceId: string,
  senderId: string,
  body: string,
  createdAt: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(admin, 'chat_messages', {
    id,
    channel_id: channelId,
    workspace_id: workspaceId,
    sender_user_id: senderId,
    body,
    agora_event_id: null,
    created_at: createdAt,
  });
  return id;
}

describe.runIf(RLS_SUITE)('chat_message_search', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: owner and userB share a DM and the scaffold group; userC is an
  // active member of A in neither channel. outsider owns workspace B only.
  let owner: SeededUser;
  let userB: SeededUser;
  let userC: SeededUser;
  let outsider: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let ctx: Ctx;
  let dmChannelId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    owner = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    userC = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Search A ${owner.email}`);
    wsB = await seedWorkspace(admin, outsider, `Search B ${outsider.email}`);
    ctx = await seedScaffold(admin, wsA);
    await seedMember(adminGeneric, wsA, userB, 'agency');
    await seedMember(adminGeneric, wsA, userC, 'client');
    await insertRow(adminGeneric, 'group_members', {
      group_id: ctx.groupId,
      user_id: userB.id,
      workspace_id: wsA.id,
    });
    dmChannelId = await seedDmChannel(adminGeneric, wsA.id, owner, userB);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, userB, userC, outsider]);
  });

  it('T1 a member finds an own-workspace message by full word and by prefix', async () => {
    const tok = token();
    const id = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} approved`,
      at(10),
    );
    const b = clientFor(userB.id);

    expect(ids(await search(b, searchArgs(wsA.id, `${tok} approved`)))).toEqual([id]);

    const prefix = await search(b, searchArgs(wsA.id, 'appr', { channelId: dmChannelId }));
    expect(ids(prefix)).toContain(id);
    for (const row of prefix) expect((row.body ?? '').toLowerCase()).toContain('appr');

    // Case-insensitive, and the sender reads the same row.
    expect(
      ids(await search(clientFor(owner.id), searchArgs(wsA.id, `${tok.toUpperCase()} APPR`))),
    ).toEqual([id]);
  });

  it('T2 a workspace member outside the channel gets 0 rows for a message that exists', async () => {
    const tok = token();
    const id = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} private`,
      at(20),
    );
    expect(await countWhere(adminGeneric, 'chat_messages', [['id', id]])).toBe(1);
    expect(await search(clientFor(userB.id), searchArgs(wsA.id, tok))).toHaveLength(1);
    expect(await search(clientFor(userC.id), searchArgs(wsA.id, tok))).toHaveLength(0);
    expect(
      await search(clientFor(userC.id), searchArgs(wsA.id, tok, { channelId: dmChannelId })),
    ).toHaveLength(0);
  });

  it('T3 a user in workspace B gets 0 rows searching workspace A', async () => {
    const tok = token();
    await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id, `${tok} tenant`, at(30));
    await seedMessage(adminGeneric, ctx.channelId, wsA.id, owner.id, `${tok} tenant`, at(31));
    expect(await search(clientFor(userB.id), searchArgs(wsA.id, tok))).toHaveLength(2);
    const o = clientFor(outsider.id);
    expect(await search(o, searchArgs(wsA.id, tok))).toHaveLength(0);
    expect(await search(o, searchArgs(wsA.id, tok, { channelId: ctx.channelId }))).toHaveLength(0);
    // Searching its own workspace for A's words also finds nothing.
    expect(await search(o, searchArgs(wsB.id, tok))).toHaveLength(0);
  });

  it('T5 a soft-deleted message is not returned', async () => {
    const tok = token();
    const live = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} keep`,
      at(40),
    );
    const gone = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} keep`,
      at(41),
    );
    const upd = await adminGeneric
      .from('chat_messages')
      .update({ deleted_at: at(42) })
      .eq('id', gone);
    expect(upd.error).toBeNull();
    // The deleted row is still readable through RLS (tombstone), but search skips it.
    const direct = await clientFor(userB.id).from('chat_messages').select('id').eq('id', gone);
    expect(direct.data ?? []).toHaveLength(1);
    expect(ids(await search(clientFor(userB.id), searchArgs(wsA.id, `${tok} keep`)))).toEqual([
      live,
    ]);
  });

  it('T6 a multi-word query requires every word', async () => {
    const tok = token();
    const one = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} alpha`,
      at(50),
    );
    const both = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} alpha beta`,
      at(51),
    );
    const b = clientFor(userB.id);
    expect(ids(await search(b, searchArgs(wsA.id, `${tok} alpha`)))).toEqual([both, one]);
    expect(ids(await search(b, searchArgs(wsA.id, `${tok} alpha beta`)))).toEqual([both]);
    expect(ids(await search(b, searchArgs(wsA.id, `${tok}   beta   alpha`)))).toEqual([both]);
    expect(await search(b, searchArgs(wsA.id, `${tok} alpha gamma`))).toHaveLength(0);
  });

  it('T7 operator characters, quotes and backslash return without error', async () => {
    const tok = token();
    const id = await seedMessage(
      adminGeneric,
      dmChannelId,
      wsA.id,
      owner.id,
      `${tok} opsa opsb`,
      at(60),
    );
    const b = clientFor(userB.id);
    const hostile = ['a&b|!(:*', `it's "quoted"`, 'back\\slash', '\\\\', `''`, '<->:*!'];
    for (const q of hostile) {
      const res = await b.rpc('chat_message_search', searchArgs(wsA.id, q));
      expect(res.error).toBeNull();
      expect(Array.isArray(res.data)).toBe(true);
    }
    // Operators are treated as word separators, so the words still AND-match.
    expect(ids(await search(b, searchArgs(wsA.id, `${tok}&opsa|!(:*`)))).toEqual([id]);
    expect(ids(await search(b, searchArgs(wsA.id, `"${tok}" 'opsb'`)))).toEqual([id]);
  });

  it('T8 queries under 2 chars and over 100 chars return 0 rows without error', async () => {
    const tok = token();
    await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id, `x ${tok}`, at(70));
    const b = clientFor(userB.id);
    expect(await search(b, searchArgs(wsA.id, `x ${tok}`))).toHaveLength(1);
    for (const q of ['x', ' x ', '', '   ']) {
      const res = await b.rpc('chat_message_search', searchArgs(wsA.id, q));
      expect(res.error).toBeNull();
      expect(res.data ?? []).toHaveLength(0);
    }
    // Every word matches the seeded message; only the length guard returns 0.
    const long = Array.from({ length: 12 }, () => tok).join(' ');
    expect(long.trim().length).toBeGreaterThan(100);
    const res = await b.rpc('chat_message_search', searchArgs(wsA.id, long));
    expect(res.error).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it('T9 keyset paging has no duplicates or gaps; p_channel_id limits to one chat', async () => {
    const tok = token();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id, `${tok} page`, at(80 + i)),
      );
    }
    // Two rows sharing one created_at exercise the id tie-break.
    seeded.push(
      await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id, `${tok} page`, at(84)),
    );
    const groupId = await seedMessage(
      adminGeneric,
      ctx.channelId,
      wsA.id,
      owner.id,
      `${tok} page`,
      at(90),
    );

    const b = clientFor(userB.id);
    const all = await search(b, searchArgs(wsA.id, tok, { channelId: dmChannelId, limit: 50 }));
    expect(all.map((r) => r.channel_id).every((c) => c === dmChannelId)).toBe(true);
    expect([...ids(all)].sort()).toEqual([...seeded].sort());
    const expected = ids(
      [...all].sort((x, y) =>
        x.created_at === y.created_at
          ? x.id < y.id
            ? 1
            : -1
          : x.created_at < y.created_at
            ? 1
            : -1,
      ),
    );
    expect(ids(all)).toEqual(expected);

    const paged: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const rows: SearchRow[] = await search(
        b,
        searchArgs(wsA.id, tok, {
          channelId: dmChannelId,
          limit: 2,
          ...(cursor ? { beforeCreatedAt: cursor.createdAt, beforeId: cursor.id } : {}),
        }),
      );
      expect(rows.length).toBeLessThanOrEqual(2);
      if (rows.length === 0) break;
      paged.push(...ids(rows));
      const last = rows[rows.length - 1];
      if (!last) break;
      cursor = { createdAt: last.created_at, id: last.id };
    }
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual(expected);

    // Without the channel filter the group message joins the results.
    const wide = ids(await search(b, searchArgs(wsA.id, tok, { limit: 50 })));
    expect(wide).toContain(groupId);
    expect(wide).toHaveLength(seeded.length + 1);
    // The limit is clamped to 1..50.
    expect(await search(b, searchArgs(wsA.id, tok, { limit: 0 }))).toHaveLength(1);
    expect((await search(b, searchArgs(wsA.id, tok, { limit: 500 }))).length).toBeLessThanOrEqual(
      50,
    );
  });

  it('T10 anon cannot execute', async () => {
    const anon = createAnonClient(loadRlsEnv());
    const res = await anon.rpc('chat_message_search', searchArgs(wsA.id, 'anything'));
    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // Runs last: clearing the group channel for userB hides its older rows.
  it('T4 a message at or before the caller clear point is not returned', async () => {
    const tok = token();
    const older = await seedMessage(
      adminGeneric,
      ctx.channelId,
      wsA.id,
      owner.id,
      `${tok} clear`,
      at(100),
    );
    const b = clientFor(userB.id);
    expect(ids(await search(b, searchArgs(wsA.id, tok, { channelId: ctx.channelId })))).toEqual([
      older,
    ]);

    const clear: ClearArgs = { p_channel_id: ctx.channelId, p_trace_id: generateTraceId() };
    const cleared = await b.rpc('chat_channel_clear', clear);
    expect(cleared.error).toBeNull();

    const send: SendArgs = {
      p_id: crypto.randomUUID(),
      p_channel_id: ctx.channelId,
      p_trace_id: generateTraceId(),
      p_body: `${tok} clear`,
    };
    const sent = await clientFor(owner.id).rpc('chat_message_send', send);
    expect(sent.error).toBeNull();
    const newer = sent.data?.id ?? '';

    expect(ids(await search(b, searchArgs(wsA.id, tok, { channelId: ctx.channelId })))).toEqual([
      newer,
    ]);
    // The other member is unaffected by userB's clear.
    expect(ids(await search(clientFor(owner.id), searchArgs(wsA.id, tok)))).toEqual([newer, older]);
  });
});
