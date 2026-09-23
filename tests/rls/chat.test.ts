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
// Follow-ups (20260922210000_chat_sync_guard_and_unread.sql):
//
//   5. The member trigger is guarded: a workspace hard-delete cascading through
//      group_members succeeds and leaves no chat_sync_events rows behind.
//   6. chat_unread_counts returns one row per channel the caller can read, with
//      the unread count relative to the caller's read cursor (if any).
//
// Fix-wave foundation (20260923103500_chat_shared_posts_and_deactivation.sql):
//
//   7. chat_message_send accepts a shared-posts-only message and rejects a
//      reply whose target lives in another channel.
//   8. Flipping workspace_members.active enqueues member_remove / member_add
//      for every group channel the user is in.
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
  extra: { id?: string; attachments?: string[]; sharedPosts?: string[]; replyTo?: string } = {},
): SendArgs {
  const args: SendArgs = {
    p_id: extra.id ?? crypto.randomUUID(),
    p_channel_id: channelId,
    p_trace_id: generateTraceId(),
  };
  if (body !== null) args.p_body = body;
  if (extra.attachments) args.p_attachment_asset_ids = extra.attachments;
  if (extra.sharedPosts) args.p_shared_post_ids = extra.sharedPosts;
  if (extra.replyTo) args.p_reply_to_message_id = extra.replyTo;
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
      expect(res.error?.message).toBe('message has no body, attachments or shared posts');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', empty.p_id]])).toBe(0);

      const blank = sendArgs(ctx.channelId, '   ');
      const resBlank = await clientFor(userB.id).rpc('chat_message_send', blank);
      expect(resBlank.error?.message).toBe('message has no body, attachments or shared posts');

      const missing = sendArgs(ctx.channelId, null);
      const resMissing = await clientFor(userB.id).rpc('chat_message_send', missing);
      expect(resMissing.error?.message).toBe('message has no body, attachments or shared posts');
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

    it('accepts a shared-posts-only message', async () => {
      const args = sendArgs(ctx.channelId, null, { sharedPosts: [ctx.postId] });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.body).toBeNull();
      expect(res.data?.attachment_asset_ids).toBeNull();
      expect(res.data?.shared_post_ids).toEqual([ctx.postId]);
    });

    it('raises when the reply target is a message from another channel', async () => {
      // userB is in both the DM and the group, so only the channel check can fail.
      const args = sendArgs(ctx.channelId, 'reply', { replyTo: dmMessageId });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('reply target not in this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
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

  // -------------------------------------------------------------------------
  // 5. chat_sync_enqueue_member guard (workspace hard-delete cascade)
  // -------------------------------------------------------------------------

  describe('chat_sync_enqueue_member guard', () => {
    it('a workspace with groups and group members hard-deletes cleanly and leaves no outbox rows', async () => {
      // A workspace of its own, so the delete cannot disturb the shared fixtures.
      const wsDel = await seedWorkspace(admin, outsider, `Chat D ${outsider.email}`);
      await seedMember(adminGeneric, wsDel, userB, 'agency');
      const group = await insertRow(adminGeneric, 'groups', {
        workspace_id: wsDel.id,
        name: `Grp ${randomSuffix()}`,
        created_by: outsider.id,
      });
      await insertRow(adminGeneric, 'chat_channels', {
        channel_id: `group__${wsDel.id}__${String(group.id)}`,
        workspace_id: wsDel.id,
        channel_type: 'group',
        entity_id: group.id,
      });
      for (const user of [outsider, userB]) {
        await insertRow(adminGeneric, 'group_members', {
          group_id: group.id,
          user_id: user.id,
          workspace_id: wsDel.id,
        });
      }
      const match: MatchSpec = [['workspace_id', wsDel.id]];
      // The live path still enqueues: workspace and channel both exist.
      expect(await countWhere(adminGeneric, 'chat_sync_events', match)).toBe(2);

      // Hard-delete the workspace WITHOUT clearing group_members first. The
      // cascade fires the member trigger after the workspace row is gone, which
      // used to raise on the outbox's workspace FK.
      const del = await adminGeneric.from('workspaces').delete().eq('id', wsDel.id);
      expect(del.error).toBeNull();
      expect(await countWhere(adminGeneric, 'workspaces', [['id', wsDel.id]])).toBe(0);
      expect(await countWhere(adminGeneric, 'group_members', match)).toBe(0);
      expect(await countWhere(adminGeneric, 'chat_sync_events', match)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. chat_unread_counts
  // -------------------------------------------------------------------------

  describe('chat_unread_counts', () => {
    type UnreadRow = Database['public']['Functions']['chat_unread_counts']['Returns'][number];
    interface SentMessage {
      id: string;
      created_at: string;
    }

    // Fresh channels for owner + userC so the expected counts are exact: the
    // scaffold messages sit at partitionTimestamp, outside the function's
    // 90-day window, so everything counted here is sent through
    // chat_message_send (server-stamped now()).
    let dm2: string;
    let group2Channel: string;
    let ownerDm: SentMessage[];
    let userCDm: SentMessage;

    async function sendAs(userId: string, channelId: string, body: string): Promise<SentMessage> {
      const res = await clientFor(userId).rpc('chat_message_send', sendArgs(channelId, body));
      if (res.error || !res.data) {
        throw new Error(`chat_message_send failed: ${res.error?.message ?? 'no row'}`);
      }
      return { id: res.data.id, created_at: res.data.created_at };
    }

    async function unreadFor(userId: string, workspaceId: string): Promise<UnreadRow[]> {
      // chat_unread_counts is a SECURITY INVOKER read function whose live
      // signature is (p_workspace_id uuid) only: it takes no trace parameter,
      // and sending one would break the PostgREST function lookup (same
      // exemption as audit_log_write in src/server/audit.ts).
      // eslint-disable-next-line no-restricted-syntax
      const res = await clientFor(userId).rpc('chat_unread_counts', {
        p_workspace_id: workspaceId,
      });
      if (res.error) throw new Error(`chat_unread_counts failed: ${res.error.message}`);
      return res.data ?? [];
    }

    function rowFor(rows: UnreadRow[], channelId: string): UnreadRow | undefined {
      return rows.find((r) => r.channel_id === channelId);
    }

    beforeAll(async () => {
      dm2 = await seedDmChannel(adminGeneric, wsA.id, owner, userC);
      const group2 = await insertRow(adminGeneric, 'groups', {
        workspace_id: wsA.id,
        name: `Grp ${randomSuffix()}`,
        created_by: owner.id,
      });
      group2Channel = `group__${wsA.id}__${String(group2.id)}`;
      await insertRow(adminGeneric, 'chat_channels', {
        channel_id: group2Channel,
        workspace_id: wsA.id,
        channel_type: 'group',
        entity_id: group2.id,
      });
      for (const user of [owner, userC]) {
        await insertRow(adminGeneric, 'group_members', {
          group_id: group2.id,
          user_id: user.id,
          workspace_id: wsA.id,
        });
      }

      // DM: owner sends three, then userC replies once. Group: owner sends two.
      ownerDm = [];
      for (const body of ['dm 1', 'dm 2', 'dm 3']) ownerDm.push(await sendAs(owner.id, dm2, body));
      userCDm = await sendAs(userC.id, dm2, 'dm reply');
      await sendAs(owner.id, group2Channel, 'group 1');
      await sendAs(owner.id, group2Channel, 'group 2');
    });

    it('without a cursor: one row per member channel, own messages excluded', async () => {
      const rows = await unreadFor(userC.id, wsA.id);
      // userC is a member of exactly dm2 and group2 (its scaffold-group
      // membership was removed by the outbox test above).
      expect(rows.map((r) => r.channel_id).sort()).toEqual([dm2, group2Channel].sort());

      const dm = rowFor(rows, dm2);
      expect(dm?.unread).toBe(3);
      expect(Date.parse(dm?.last_message_at ?? '')).toBe(Date.parse(userCDm.created_at));
      expect(rowFor(rows, group2Channel)?.unread).toBe(2);

      // The other side of the same channels: only userC's reply is unread for
      // the owner, and the group the owner alone wrote to has nothing unread.
      const ownerRows = await unreadFor(owner.id, wsA.id);
      expect(rowFor(ownerRows, dm2)?.unread).toBe(1);
      expect(rowFor(ownerRows, group2Channel)?.unread).toBe(0);
    });

    it('returns nothing for channels the caller is not a member of', async () => {
      // A workspace member in neither channel gets no row for them.
      const bRows = await unreadFor(userB.id, wsA.id);
      expect(rowFor(bRows, dm2)).toBeUndefined();
      expect(rowFor(bRows, group2Channel)).toBeUndefined();

      // Not a member of the workspace at all: no rows.
      expect(await unreadFor(outsider.id, wsA.id)).toEqual([]);

      // userC reads the owner/userB DM and the scaffold group in no case.
      const cRows = await unreadFor(userC.id, wsA.id);
      expect(rowFor(cRows, dmChannelId)).toBeUndefined();
      expect(rowFor(cRows, ctx.channelId)).toBeUndefined();
    });

    it('with a cursor: only later messages from other senders count', async () => {
      const second = ownerDm[1];
      if (!second) throw new Error('fixture: expected three owner DM messages');

      const mid = await clientFor(userC.id).rpc('chat_read_cursor_set', cursorArgs(dm2, second.id));
      expect(mid.error).toBeNull();
      let dm = rowFor(await unreadFor(userC.id, wsA.id), dm2);
      // Only 'dm 3' is after the cursor and not userC's own.
      expect(dm?.unread).toBe(1);
      expect(Date.parse(dm?.last_message_at ?? '')).toBe(Date.parse(userCDm.created_at));

      const latest = await clientFor(userC.id).rpc(
        'chat_read_cursor_set',
        cursorArgs(dm2, userCDm.id),
      );
      expect(latest.error).toBeNull();
      dm = rowFor(await unreadFor(userC.id, wsA.id), dm2);
      // Fully read: the channel row stays (one row per channel), count is zero.
      expect(dm?.unread).toBe(0);

      // The cursor is per user: the owner's count is unchanged.
      expect(rowFor(await unreadFor(owner.id, wsA.id), dm2)?.unread).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 8. workspace_members.active flips reach the outbox
  // -------------------------------------------------------------------------

  describe('chat_sync_enqueue_membership_state', () => {
    it('deactivating enqueues one member_remove per group channel; reactivating enqueues member_add', async () => {
      // A workspace of its own, so the flips cannot disturb the shared fixtures.
      const wsFlip = await seedWorkspace(admin, outsider, `Chat F ${outsider.email}`);
      await seedMember(adminGeneric, wsFlip, userC, 'agency');
      const channelIds: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const group = await insertRow(adminGeneric, 'groups', {
          workspace_id: wsFlip.id,
          name: `Grp ${randomSuffix()}`,
          created_by: outsider.id,
        });
        const channelId = `group__${wsFlip.id}__${String(group.id)}`;
        await insertRow(adminGeneric, 'chat_channels', {
          channel_id: channelId,
          workspace_id: wsFlip.id,
          channel_type: 'group',
          entity_id: group.id,
        });
        await insertRow(adminGeneric, 'group_members', {
          group_id: group.id,
          user_id: userC.id,
          workspace_id: wsFlip.id,
        });
        channelIds.push(channelId);
      }
      channelIds.sort();

      const removeMatch: MatchSpec = [
        ['workspace_id', wsFlip.id],
        ['user_id', userC.id],
        ['event_type', 'member_remove'],
      ];
      const addMatch: MatchSpec = [
        ['workspace_id', wsFlip.id],
        ['user_id', userC.id],
        ['event_type', 'member_add'],
      ];
      // The group_members inserts already enqueued one member_add per channel.
      expect(await syncEvents(adminGeneric, removeMatch)).toHaveLength(0);
      expect(await syncEvents(adminGeneric, addMatch)).toHaveLength(2);

      const setActive = (active: boolean) =>
        adminGeneric
          .from('workspace_members')
          .update({ active })
          .eq('workspace_id', wsFlip.id)
          .eq('user_id', userC.id);

      expect((await setActive(false)).error).toBeNull();
      const removed = await syncEvents(adminGeneric, removeMatch);
      expect(removed.map((e) => e.channel_id).sort()).toEqual(channelIds);
      expect(await syncEvents(adminGeneric, addMatch)).toHaveLength(2);

      // Re-writing the same value is not a flip (IS NOT DISTINCT FROM guard).
      expect((await setActive(false)).error).toBeNull();
      expect(await syncEvents(adminGeneric, removeMatch)).toHaveLength(2);

      expect((await setActive(true)).error).toBeNull();
      const added = await syncEvents(adminGeneric, addMatch);
      expect(added).toHaveLength(4);
      expect(await syncEvents(adminGeneric, removeMatch)).toHaveLength(2);

      const del = await adminGeneric.from('workspaces').delete().eq('id', wsFlip.id);
      expect(del.error).toBeNull();
    });
  });
});
