// Chat record contract (20260922200000_chat_postgres_record.sql): Postgres
// chat_messages is the chat record and the only read path, so its access rules
// are tested here directly against the local container.
//
//   1. chat_messages RLS is gated by chat_channel_member: a workspace member who
//      is not a DM participant / group member reads zero rows from that channel.
//   2. chat_message_send is idempotent on p_id, rejects non-members and empty
//      messages, and stamps created_at server-side.
//   3. chat_reactions and chat_read_cursors carry the same channel isolation,
//      for both direct reads and the SECURITY DEFINER procs.
//   4. group_members / groups changes enqueue chat_sync_events rows, which the
//      authenticated role can never read.
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
  generateTraceId,
  insertRow,
  loadRlsEnv,
  ownReadCount,
  partitionTimestamp,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedScaffold,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type Ctx,
  type GenericClient,
  type MatchSpec,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type SendArgs = Database['public']['Functions']['chat_message_send']['Args'];
// chat_reaction_add and chat_reaction_remove share one argument shape.
type ReactionArgs = Database['public']['Functions']['chat_reaction_add']['Args'];
type CursorArgs = Database['public']['Functions']['chat_read_cursor_set']['Args'];

// Proc arguments are built here (not inline at the .rpc() call) so each call
// carries a fresh trace id the way the app's callRpc() wrapper does.
function reactionArgs(messageId: string, channelId: string, emoji: string): ReactionArgs {
  return {
    p_message_id: messageId,
    p_channel_id: channelId,
    p_emoji: emoji,
    p_trace_id: generateTraceId(),
  };
}

function cursorArgs(channelId: string, messageId: string): CursorArgs {
  return { p_channel_id: channelId, p_message_id: messageId, p_trace_id: generateTraceId() };
}

/** Build chat_message_send args; `body` null omits p_body (attachments-only sends). */
function sendArgs(
  channelId: string,
  body: string | null,
  extra: { id?: string; attachments?: string[] } = {},
): SendArgs {
  const args: SendArgs = {
    p_id: extra.id ?? crypto.randomUUID(),
    p_channel_id: channelId,
    p_trace_id: generateTraceId(),
  };
  if (body !== null) args.p_body = body;
  if (extra.attachments) args.p_attachment_asset_ids = extra.attachments;
  return args;
}

interface SyncEventRow {
  event_type: string;
  channel_id: string;
  user_id: string | null;
  payload: unknown;
  processed_at: string | null;
}

/** chat_sync_events rows matching `match`, read through the service role. */
async function syncEvents(admin: GenericClient, match: MatchSpec): Promise<SyncEventRow[]> {
  let q = admin.from('chat_sync_events').select('*');
  for (const [column, value] of match) q = q.eq(column, value);
  const res = await q;
  if (res.error) throw new Error(`chat_sync_events read failed: ${res.error.message}`);
  return (res.data as SyncEventRow[] | null) ?? [];
}

/** Seed one chat_messages row through the service role and return its id. */
async function seedMessage(
  admin: GenericClient,
  channelId: string,
  workspaceId: string,
  senderId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(admin, 'chat_messages', {
    id,
    channel_id: channelId,
    workspace_id: workspaceId,
    sender_user_id: senderId,
    body: `seeded ${randomSuffix()}`,
    agora_event_id: null,
    created_at: partitionTimestamp,
  });
  return id;
}

describe.runIf(RLS_SUITE)('chat record: channel-membership RLS and procs', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: owner (a group member via the scaffold), userB (group member +
  // DM participant), userC (active workspace member, in neither channel).
  let owner: SeededUser;
  let userB: SeededUser;
  let userC: SeededUser;
  // Owner of an unrelated workspace: not a member of workspace A at all.
  let outsider: SeededUser;
  let wsA: SeededWorkspace;
  let wsOther: SeededWorkspace;
  let ctx: Ctx;
  let dmChannelId: string;
  let dmMessageId: string;
  let ownerClient: GenericClient;
  let bClient: GenericClient;
  let cClient: GenericClient;
  let outsiderClient: GenericClient;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    owner = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    userC = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Chat A ${owner.email}`);
    wsOther = await seedWorkspace(admin, outsider, `Chat O ${outsider.email}`);
    ctx = await seedScaffold(admin, wsA);
    await seedMember(adminGeneric, wsA, userB, 'agency');
    await seedMember(adminGeneric, wsA, userC, 'client');

    // userB joins the scaffold group (owner is already a member); userC does not.
    await insertRow(adminGeneric, 'group_members', {
      group_id: ctx.groupId,
      user_id: userB.id,
      workspace_id: wsA.id,
    });

    // DM between owner and userB with one seeded message.
    dmChannelId = await seedDmChannel(adminGeneric, wsA.id, owner, userB);
    dmMessageId = await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id);

    ownerClient = asGeneric(clientFor(owner.id));
    bClient = asGeneric(clientFor(userB.id));
    cClient = asGeneric(clientFor(userC.id));
    outsiderClient = asGeneric(clientFor(outsider.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsOther], [owner, userB, userC, outsider]);
  });

  // -------------------------------------------------------------------------
  // 1. chat_messages RLS
  // -------------------------------------------------------------------------

  describe('chat_messages SELECT is gated by chat_channel_member', () => {
    it('DM: a workspace member who is not a participant reads zero rows', async () => {
      const match: MatchSpec = [['channel_id', dmChannelId]];
      expect(await countWhere(adminGeneric, 'chat_messages', match)).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_messages', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_messages', match)).toBe(0);
    });

    it('DM: both participants read the rows', async () => {
      const match: MatchSpec = [['channel_id', dmChannelId]];
      const seeded = await countWhere(adminGeneric, 'chat_messages', match);
      expect(await ownReadCount(ownerClient, 'chat_messages', match)).toBe(seeded);
      expect(await ownReadCount(bClient, 'chat_messages', match)).toBe(seeded);
    });

    it('group: a workspace member who is not in group_members reads zero rows', async () => {
      const match: MatchSpec = [['channel_id', ctx.channelId]];
      expect(await countWhere(adminGeneric, 'chat_messages', match)).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_messages', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_messages', match)).toBe(0);
    });

    it('group: a group member reads the rows', async () => {
      const match: MatchSpec = [['channel_id', ctx.channelId]];
      const seeded = await countWhere(adminGeneric, 'chat_messages', match);
      expect(await ownReadCount(bClient, 'chat_messages', match)).toBe(seeded);
      expect(await ownReadCount(ownerClient, 'chat_messages', match)).toBe(seeded);
    });

    it('soft-deleted messages are hidden even from a participant', async () => {
      const id = await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id);
      const upd = await adminGeneric
        .from('chat_messages')
        .update({ deleted_at: partitionTimestamp })
        .eq('id', id);
      expect(upd.error).toBeNull();
      expect(await visibleRowCount(bClient, 'chat_messages', [['id', id]])).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. chat_message_send
  // -------------------------------------------------------------------------

  describe('chat_message_send', () => {
    it('inserts once and returns the same row on a repeat call with the same p_id', async () => {
      const args = sendArgs(ctx.channelId, 'first send');
      const before = Date.now();
      const first = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(first.error).toBeNull();
      expect(first.data?.id).toBe(args.p_id);
      expect(first.data?.channel_id).toBe(ctx.channelId);
      expect(first.data?.workspace_id).toBe(wsA.id);
      expect(first.data?.sender_user_id).toBe(userB.id);
      expect(first.data?.body).toBe('first send');
      expect(first.data?.agora_event_id).toBeNull();

      // created_at is server time: the proc takes no timestamp argument and the
      // returned value lands within a minute of the call (never the partition
      // fixture timestamp a client might try to supply).
      const createdAt = Date.parse(first.data?.created_at ?? '');
      expect(Number.isNaN(createdAt)).toBe(false);
      expect(Math.abs(createdAt - before)).toBeLessThan(60_000);
      expect(first.data?.created_at).not.toBe(partitionTimestamp);

      // Second call, same p_id, different body: the original row comes back and
      // nothing new is inserted.
      const retry: SendArgs = { ...args, p_body: 'second attempt', p_trace_id: generateTraceId() };
      const again = await clientFor(userB.id).rpc('chat_message_send', retry);
      expect(again.error).toBeNull();
      expect(again.data?.id).toBe(args.p_id);
      expect(again.data?.body).toBe('first send');
      expect(again.data?.created_at).toBe(first.data?.created_at);
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(1);
    });

    it('raises for a workspace member who is not a member of the channel', async () => {
      const groupArgs = sendArgs(ctx.channelId, 'intruder');
      const group = await clientFor(userC.id).rpc('chat_message_send', groupArgs);
      expect(group.error?.message).toBe('not a member of this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', groupArgs.p_id]])).toBe(0);

      const dmArgs = sendArgs(dmChannelId, 'intruder');
      const dm = await clientFor(userC.id).rpc('chat_message_send', dmArgs);
      expect(dm.error?.message).toBe('not a member of this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', dmArgs.p_id]])).toBe(0);
    });

    it('raises for a user outside the workspace', async () => {
      const args = sendArgs(ctx.channelId, 'outsider');
      const res = await clientFor(outsider.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('not a member of this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
    });

    it('raises when the body is empty or blank and there are no attachments', async () => {
      const empty = sendArgs(ctx.channelId, '');
      const res = await clientFor(userB.id).rpc('chat_message_send', empty);
      expect(res.error?.message).toBe('message has no body and no attachments');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', empty.p_id]])).toBe(0);

      const blank = sendArgs(ctx.channelId, '   ');
      const resBlank = await clientFor(userB.id).rpc('chat_message_send', blank);
      expect(resBlank.error?.message).toBe('message has no body and no attachments');

      const missing = sendArgs(ctx.channelId, null);
      const resMissing = await clientFor(userB.id).rpc('chat_message_send', missing);
      expect(resMissing.error?.message).toBe('message has no body and no attachments');
    });

    it('accepts an attachments-only message', async () => {
      const args = sendArgs(ctx.channelId, null, { attachments: [ctx.assetId] });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.body).toBeNull();
      expect(res.data?.attachment_asset_ids).toEqual([ctx.assetId]);
    });

    it('raises when the body exceeds 5000 characters', async () => {
      const args = sendArgs(ctx.channelId, 'x'.repeat(5001));
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('body exceeds 5000 characters');
    });
  });

  // -------------------------------------------------------------------------
  // 3. chat_reactions and chat_read_cursors
  // -------------------------------------------------------------------------

  describe('chat_reactions RLS', () => {
    let dmMatch: MatchSpec;
    let groupMatch: MatchSpec;

    beforeAll(async () => {
      await insertRow(adminGeneric, 'chat_reactions', {
        message_id: dmMessageId,
        channel_id: dmChannelId,
        workspace_id: wsA.id,
        user_id: owner.id,
        emoji: 'dm',
      });
      await insertRow(adminGeneric, 'chat_reactions', {
        message_id: ctx.chatMessageId,
        channel_id: ctx.channelId,
        workspace_id: wsA.id,
        user_id: owner.id,
        emoji: 'grp',
      });
      dmMatch = [['message_id', dmMessageId]];
      groupMatch = [['message_id', ctx.chatMessageId]];
    });

    it('DM: non-participant reads zero rows, participants read them', async () => {
      const seeded = await countWhere(adminGeneric, 'chat_reactions', dmMatch);
      expect(seeded).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_reactions', dmMatch)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_reactions', dmMatch)).toBe(0);
      expect(await ownReadCount(bClient, 'chat_reactions', dmMatch)).toBe(seeded);
      expect(await ownReadCount(ownerClient, 'chat_reactions', dmMatch)).toBe(seeded);
    });

    it('group: non-member reads zero rows, group members read them', async () => {
      const seeded = await countWhere(adminGeneric, 'chat_reactions', groupMatch);
      expect(seeded).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_reactions', groupMatch)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_reactions', groupMatch)).toBe(0);
      expect(await ownReadCount(bClient, 'chat_reactions', groupMatch)).toBe(seeded);
    });

    it('direct INSERT as authenticated is denied even for a channel member', async () => {
      const values = {
        message_id: ctx.chatMessageId,
        channel_id: ctx.channelId,
        workspace_id: wsA.id,
        user_id: userB.id,
        emoji: `d${randomSuffix()}`,
      };
      const res = await authInsert(bClient, 'chat_reactions', values);
      expect(res.ok && res.count > 0).toBe(false);
      expect(
        await countWhere(adminGeneric, 'chat_reactions', [
          ['user_id', userB.id],
          ['emoji', values.emoji],
        ]),
      ).toBe(0);
    });

    it('chat_reaction_add / chat_reaction_remove enforce channel membership', async () => {
      const emoji = `r${randomSuffix()}`;
      const deniedArgs = reactionArgs(ctx.chatMessageId, ctx.channelId, emoji);
      const denied = await clientFor(userC.id).rpc('chat_reaction_add', deniedArgs);
      expect(denied.error?.message).toBe('not a member of this chat');

      const match: MatchSpec = [
        ['message_id', ctx.chatMessageId],
        ['user_id', userB.id],
        ['emoji', emoji],
      ];
      const addArgs = reactionArgs(ctx.chatMessageId, ctx.channelId, emoji);
      const added = await clientFor(userB.id).rpc('chat_reaction_add', addArgs);
      expect(added.error).toBeNull();
      expect(await countWhere(adminGeneric, 'chat_reactions', match)).toBe(1);
      expect(await ownReadCount(bClient, 'chat_reactions', match)).toBe(1);
      expect(await ownReadCount(ownerClient, 'chat_reactions', match)).toBe(1);
      expect(await visibleRowCount(cClient, 'chat_reactions', match)).toBe(0);

      // Idempotent: ON CONFLICT DO NOTHING.
      const againArgs = reactionArgs(ctx.chatMessageId, ctx.channelId, emoji);
      const again = await clientFor(userB.id).rpc('chat_reaction_add', againArgs);
      expect(again.error).toBeNull();
      expect(await countWhere(adminGeneric, 'chat_reactions', match)).toBe(1);

      // A message that is not in the named channel is 'message not found'
      // (channel-scoped lookup, so a DM message id cannot be reacted to via a group).
      const wrongChannelArgs = reactionArgs(dmMessageId, ctx.channelId, emoji);
      const wrongChannel = await clientFor(userB.id).rpc('chat_reaction_add', wrongChannelArgs);
      expect(wrongChannel.error?.message).toBe('message not found');

      const removeArgs = reactionArgs(ctx.chatMessageId, ctx.channelId, emoji);
      const removed = await clientFor(userB.id).rpc('chat_reaction_remove', removeArgs);
      expect(removed.error).toBeNull();
      expect(await countWhere(adminGeneric, 'chat_reactions', match)).toBe(0);
    });
  });

  describe('chat_read_cursors RLS', () => {
    beforeAll(async () => {
      await insertRow(adminGeneric, 'chat_read_cursors', {
        channel_id: dmChannelId,
        user_id: owner.id,
        workspace_id: wsA.id,
        last_read_message_id: dmMessageId,
        last_read_at: partitionTimestamp,
      });
      await insertRow(adminGeneric, 'chat_read_cursors', {
        channel_id: ctx.channelId,
        user_id: owner.id,
        workspace_id: wsA.id,
        last_read_message_id: ctx.chatMessageId,
        last_read_at: partitionTimestamp,
      });
    });

    it('DM: non-participant reads zero rows, participants read them', async () => {
      const match: MatchSpec = [['channel_id', dmChannelId]];
      const seeded = await countWhere(adminGeneric, 'chat_read_cursors', match);
      expect(seeded).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_read_cursors', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_read_cursors', match)).toBe(0);
      expect(await ownReadCount(bClient, 'chat_read_cursors', match)).toBe(seeded);
      expect(await ownReadCount(ownerClient, 'chat_read_cursors', match)).toBe(seeded);
    });

    it('group: non-member reads zero rows, group members read them', async () => {
      const match: MatchSpec = [['channel_id', ctx.channelId]];
      const seeded = await countWhere(adminGeneric, 'chat_read_cursors', match);
      expect(seeded).toBeGreaterThanOrEqual(1);
      expect(await visibleRowCount(cClient, 'chat_read_cursors', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_read_cursors', match)).toBe(0);
      expect(await ownReadCount(bClient, 'chat_read_cursors', match)).toBe(seeded);
    });

    it('direct INSERT as authenticated is denied even for a channel member', async () => {
      const res = await authInsert(bClient, 'chat_read_cursors', {
        channel_id: dmChannelId,
        user_id: userB.id,
        workspace_id: wsA.id,
        last_read_message_id: dmMessageId,
        last_read_at: partitionTimestamp,
      });
      expect(res.ok && res.count > 0).toBe(false);
      expect(
        await countWhere(adminGeneric, 'chat_read_cursors', [
          ['channel_id', dmChannelId],
          ['user_id', userB.id],
        ]),
      ).toBe(0);
    });

    it('chat_read_cursor_set enforces membership and only moves forward', async () => {
      const deniedArgs = cursorArgs(ctx.channelId, ctx.chatMessageId);
      const denied = await clientFor(userC.id).rpc('chat_read_cursor_set', deniedArgs);
      expect(denied.error?.message).toBe('not a member of this chat');

      const missingArgs = cursorArgs(ctx.channelId, crypto.randomUUID());
      const missing = await clientFor(userB.id).rpc('chat_read_cursor_set', missingArgs);
      expect(missing.error?.message).toBe('message not found');

      // Old (partition fixture) message first.
      const match: MatchSpec = [
        ['channel_id', ctx.channelId],
        ['user_id', userB.id],
      ];
      const firstArgs = cursorArgs(ctx.channelId, ctx.chatMessageId);
      const first = await clientFor(userB.id).rpc('chat_read_cursor_set', firstArgs);
      expect(first.error).toBeNull();
      expect(await countWhere(adminGeneric, 'chat_read_cursors', match)).toBe(1);
      expect(await ownReadCount(bClient, 'chat_read_cursors', match)).toBe(1);
      expect(await visibleRowCount(cClient, 'chat_read_cursors', match)).toBe(0);

      // A newer message (server-stamped now()) advances the cursor.
      const newerArgs = sendArgs(ctx.channelId, 'newer');
      const sent = await clientFor(userB.id).rpc('chat_message_send', newerArgs);
      expect(sent.error).toBeNull();
      const newerId = sent.data?.id ?? '';
      const advanceArgs = cursorArgs(ctx.channelId, newerId);
      const advance = await clientFor(userB.id).rpc('chat_read_cursor_set', advanceArgs);
      expect(advance.error).toBeNull();

      // Setting it back to the older message is a no-op (monotonic).
      const backArgs = cursorArgs(ctx.channelId, ctx.chatMessageId);
      const back = await clientFor(userB.id).rpc('chat_read_cursor_set', backArgs);
      expect(back.error).toBeNull();
      const row = await adminGeneric
        .from('chat_read_cursors')
        .select('last_read_message_id')
        .eq('channel_id', ctx.channelId)
        .eq('user_id', userB.id);
      const rows = (row.data as { last_read_message_id: string }[] | null) ?? [];
      expect(rows[0]?.last_read_message_id).toBe(newerId);
    });
  });

  // -------------------------------------------------------------------------
  // 4. chat_sync_events outbox
  // -------------------------------------------------------------------------

  describe('chat_sync_events outbox', () => {
    it('group_members INSERT / DELETE enqueue member_add / member_remove', async () => {
      const channelId = `group__${wsA.id}__${ctx.groupId}`;
      const match: MatchSpec = [
        ['channel_id', channelId],
        ['user_id', userC.id],
      ];
      expect(await syncEvents(adminGeneric, match)).toHaveLength(0);

      await insertRow(adminGeneric, 'group_members', {
        group_id: ctx.groupId,
        user_id: userC.id,
        workspace_id: wsA.id,
      });
      const afterAdd = await syncEvents(adminGeneric, match);
      expect(afterAdd).toHaveLength(1);
      expect(afterAdd[0]?.event_type).toBe('member_add');
      expect(afterAdd[0]?.channel_id).toBe(channelId);
      expect(afterAdd[0]?.processed_at).toBeNull();

      const del = await adminGeneric
        .from('group_members')
        .delete()
        .eq('group_id', ctx.groupId)
        .eq('user_id', userC.id);
      expect(del.error).toBeNull();
      const afterRemove = await syncEvents(adminGeneric, match);
      expect(afterRemove.map((e) => e.event_type).sort()).toEqual(['member_add', 'member_remove']);
    });

    it('groups.name UPDATE enqueues group_rename with the new name; same name is silent', async () => {
      const channelId = `group__${wsA.id}__${ctx.groupId}`;
      const match: MatchSpec = [
        ['channel_id', channelId],
        ['event_type', 'group_rename'],
      ];
      expect(await syncEvents(adminGeneric, match)).toHaveLength(0);

      const name = `Renamed ${randomSuffix()}`;
      const upd = await adminGeneric.from('groups').update({ name }).eq('id', ctx.groupId);
      expect(upd.error).toBeNull();
      const events = await syncEvents(adminGeneric, match);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ name });
      expect(events[0]?.user_id).toBeNull();

      // Re-writing the same name is not a rename (IS DISTINCT FROM guard).
      const same = await adminGeneric.from('groups').update({ name }).eq('id', ctx.groupId);
      expect(same.error).toBeNull();
      expect(await syncEvents(adminGeneric, match)).toHaveLength(1);
    });

    it('the authenticated role cannot SELECT chat_sync_events', async () => {
      const match: MatchSpec = [['workspace_id', wsA.id]];
      // Ground truth: the scaffold's own group_members insert already enqueued rows.
      expect(await countWhere(adminGeneric, 'chat_sync_events', match)).toBeGreaterThanOrEqual(1);
      for (const client of [ownerClient, bClient, cClient, outsiderClient]) {
        expect(await visibleRowCount(client, 'chat_sync_events', match)).toBe(0);
      }
    });
  });
});
