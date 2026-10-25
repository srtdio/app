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
// Marks, delete, brief sharing (20260927131500_chat_marks_delete_briefs.sql):
//
//   9. chat_message_send accepts a shared-briefs-only message.
//  10. chat_mark_set / chat_mark_resolve: commitment and decision marks are
//      frozen against re-marking, pending priority can change until resolved,
//      resolve works once, non-members cannot mark, and chat_message_marks
//      SELECT is channel-gated. Since 20260928090548 every type is resolvable
//      (see chat-marks-resolve-reopen.test.ts).
//  11. chat_message_delete soft-deletes the caller's own messages only and
//      never a marked one.
//
// Edit, delete window (20260928190717_chat_message_edit_and_delete_window.sql):
//
//  11a. chat_message_delete only reaches the caller's own messages from the
//       last 30 minutes (tombstone: deleted_at set, row kept).
//  11b. chat_message_edit edits the caller's own message body within 15
//       minutes, sets edited_at, and refuses marked or deleted messages.
//
// Forward, clear-for-me (20260927200000_chat_forward_and_clear.sql):
//
//  12. chat_message_send with p_forwarded_from_message_id raises when the
//      source is unreadable by the sender or lives in another workspace, and
//      stores the source id when it is readable.
//  13. chat_channel_clear hides the caller's rows at or before cleared_at;
//      later rows stay visible and other members are unaffected.
//  14. Table grants: a channel member can SELECT chat_message_marks,
//      chat_reactions, chat_read_cursors and chat_channel_clears directly
//      (no permission-denied error); a non-member still reads zero rows.
//
// Mentions (20260929160000_chat_mentions.sql):
//
//  15. chat_message_send / chat_message_edit validate p_mentions through
//      chat_mentions_resolve (members only, max 50, self stripped, duplicates
//      collapsed) and fan out one urgent 'mention' inbox_entries row per
//      mentioned user; edit and delete soft-delete the entries they drop.
//
// Thread root (20261003120000_chat_thread_root.sql):
//
//  16. The chat_messages_thread_root trigger stamps thread_root_message_id with
//      the top-level message of the reply's thread (through replies and
//      tombstones), null for non-replies; chat_message_send has no parameter
//      for it. chat_thread_reply_counts counts non-deleted replies per root
//      under the caller's RLS and reads only the first 200 root ids.
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
  generateTraceId,
  insertRow,
  loadRlsEnv,
  ownReadCount,
  partitionTimestamp,
  randomSuffix,
  seedAsset,
  seedDmChannel,
  seedMember,
  seedScaffold,
  seedUser,
  seedOperator,
  seedWorkspace,
  visibleRowCount,
  type Ctx,
  type GenericClient,
  type MatchSpec,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type SendArgs = Database['public']['Functions']['chat_message_send']['Args'];
// chat_reaction_add and chat_reaction_remove share one argument shape.
type ReactionArgs = Database['public']['Functions']['chat_reaction_add']['Args'];
type CursorArgs = Database['public']['Functions']['chat_read_cursor_set']['Args'];
type MarkSetArgs = Database['public']['Functions']['chat_mark_set']['Args'];
type MarkResolveArgs = Database['public']['Functions']['chat_mark_resolve']['Args'];
type DeleteArgs = Database['public']['Functions']['chat_message_delete']['Args'];
type EditArgs = Database['public']['Functions']['chat_message_edit']['Args'];
type ClearArgs = Database['public']['Functions']['chat_channel_clear']['Args'];
type ResolveArgs = Database['public']['Functions']['chat_mentions_resolve']['Args'];
// The 3-arg version (the live app's until its cleanup) and the 4-arg p_since one.
type ThreadCountFns = Database['public']['Functions']['chat_thread_reply_counts'];
type ThreadCountArgs = Exclude<ThreadCountFns, { Args: { p_since: string } }>['Args'];
type ThreadCountSinceArgs = Extract<ThreadCountFns, { Args: { p_since: string } }>['Args'];

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

function markSetArgs(
  messageId: string,
  channelId: string,
  markType: 'commitment' | 'decision' | 'pending',
  priority: 1 | 2 | null = null,
): MarkSetArgs {
  // p_priority is nullable in SQL; the generated Args type marks it required.
  return {
    p_message_id: messageId,
    p_channel_id: channelId,
    p_mark_type: markType,
    p_priority: priority as number,
    p_trace_id: generateTraceId(),
  };
}

function markResolveArgs(messageId: string, channelId: string): MarkResolveArgs {
  return { p_message_id: messageId, p_channel_id: channelId, p_trace_id: generateTraceId() };
}

function deleteArgs(messageIds: string[], channelId: string): DeleteArgs {
  return { p_message_ids: messageIds, p_channel_id: channelId, p_trace_id: generateTraceId() };
}

/** Build chat_message_edit args; `mentions` undefined omits p_mentions (the 4-arg call). */
function editArgs(messageId: string, channelId: string, body: string, mentions?: Json): EditArgs {
  const args: EditArgs = {
    p_message_id: messageId,
    p_channel_id: channelId,
    p_body: body,
    p_trace_id: generateTraceId(),
  };
  if (mentions !== undefined) args.p_mentions = mentions;
  return args;
}

/** ISO timestamp `minutes` before now (for the edit / delete windows). */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function clearArgs(channelId: string): ClearArgs {
  return { p_channel_id: channelId, p_trace_id: generateTraceId() };
}

/** Build chat_message_send args; `body` null omits p_body (attachments-only sends). */
function sendArgs(
  channelId: string,
  body: string | null,
  extra: {
    id?: string;
    attachments?: string[];
    sharedPosts?: string[];
    sharedBriefs?: string[];
    replyTo?: string;
    forwardedFrom?: string;
    mentions?: Json;
  } = {},
): SendArgs {
  const args: SendArgs = {
    p_id: extra.id ?? crypto.randomUUID(),
    p_channel_id: channelId,
    p_trace_id: generateTraceId(),
  };
  if (body !== null) args.p_body = body;
  if (extra.attachments) args.p_attachment_asset_ids = extra.attachments;
  if (extra.sharedPosts) args.p_shared_post_ids = extra.sharedPosts;
  if (extra.sharedBriefs) args.p_shared_brief_ids = extra.sharedBriefs;
  if (extra.replyTo) args.p_reply_to_message_id = extra.replyTo;
  if (extra.forwardedFrom) args.p_forwarded_from_message_id = extra.forwardedFrom;
  if (extra.mentions !== undefined) args.p_mentions = extra.mentions;
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

/**
 * Seed one chat_messages row through the service role and return its id.
 * `createdAt` defaults to partitionTimestamp; pass a recent time for rows the
 * edit / delete windows must still reach.
 */
async function seedMessage(
  admin: GenericClient,
  channelId: string,
  workspaceId: string,
  senderId: string,
  createdAt: string = partitionTimestamp,
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(admin, 'chat_messages', {
    id,
    channel_id: channelId,
    workspace_id: workspaceId,
    sender_user_id: senderId,
    body: `seeded ${randomSuffix()}`,
    agora_event_id: null,
    created_at: createdAt,
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
  // Users a single test seeds on its own (T14's extra group members), cleaned up with the rest.
  const extraUsers: SeededUser[] = [];

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    owner = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    userC = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    // Fixture owner of several workspaces: exempt from the one-workspace-per-owner
    // trigger (20261016000000_workspace_owner_limit.sql) as an active platform operator.
    await seedOperator(asGeneric(admin), outsider);
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
    await cleanupWorkspaces(admin, [wsA, wsOther], [owner, userB, userC, outsider, ...extraUsers]);
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

    it('soft-deleted messages stay visible to a participant as a tombstone, never to outsiders', async () => {
      const id = await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id);
      const upd = await adminGeneric
        .from('chat_messages')
        .update({ deleted_at: partitionTimestamp, body: null })
        .eq('id', id);
      expect(upd.error).toBeNull();
      expect(await visibleRowCount(bClient, 'chat_messages', [['id', id]])).toBe(1);
      expect(await visibleRowCount(outsiderClient, 'chat_messages', [['id', id]])).toBe(0);
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
      expect(res.error?.message).toBe(
        'message has no body, attachments, shared posts or shared briefs',
      );
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', empty.p_id]])).toBe(0);

      const blank = sendArgs(ctx.channelId, '   ');
      const resBlank = await clientFor(userB.id).rpc('chat_message_send', blank);
      expect(resBlank.error?.message).toBe(
        'message has no body, attachments, shared posts or shared briefs',
      );

      const missing = sendArgs(ctx.channelId, null);
      const resMissing = await clientFor(userB.id).rpc('chat_message_send', missing);
      expect(resMissing.error?.message).toBe(
        'message has no body, attachments, shared posts or shared briefs',
      );
    });

    it('accepts an attachments-only message', async () => {
      // p_attachment_asset_ids carries asset VERSION ids, never asset ids.
      const args = sendArgs(ctx.channelId, null, { attachments: [ctx.assetVersionId] });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.body).toBeNull();
      expect(res.data?.attachment_asset_ids).toEqual([ctx.assetVersionId]);
    });

    it("refuses another workspace's asset version id ('attachment not available')", async () => {
      const foreign = await seedAsset(adminGeneric, wsOther.id, outsider.id);
      const args = sendArgs(ctx.channelId, null, { attachments: [foreign.versionId] });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('attachment not available');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
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

    it('accepts a shared-briefs-only message', async () => {
      const args = sendArgs(ctx.channelId, null, { sharedBriefs: [ctx.briefId] });
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.body).toBeNull();
      expect(res.data?.shared_post_ids).toBeNull();
      expect(res.data?.shared_brief_ids).toEqual([ctx.briefId]);
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

  // -------------------------------------------------------------------------
  // 10. chat_message_marks
  // -------------------------------------------------------------------------

  describe('chat_message_marks', () => {
    interface MarkRow {
      mark_type: string;
      priority: number | null;
      marked_by: string | null;
      resolved_by: string | null;
      resolved_at: string | null;
    }

    async function markRow(messageId: string): Promise<MarkRow | undefined> {
      const res = await adminGeneric
        .from('chat_message_marks')
        .select('*')
        .eq('message_id', messageId);
      if (res.error) throw new Error(`chat_message_marks read failed: ${res.error.message}`);
      return ((res.data as MarkRow[] | null) ?? [])[0];
    }

    async function groupMessage(): Promise<string> {
      return seedMessage(adminGeneric, ctx.channelId, wsA.id, owner.id);
    }

    it('a commitment mark is frozen: a second mark of any type raises', async () => {
      const id = await groupMessage();
      const set = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'commitment'),
      );
      expect(set.error).toBeNull();
      const row = await markRow(id);
      expect(row?.mark_type).toBe('commitment');
      expect(row?.marked_by).toBe(userB.id);

      for (const type of ['commitment', 'decision', 'pending'] as const) {
        const again = await clientFor(owner.id).rpc(
          'chat_mark_set',
          markSetArgs(id, ctx.channelId, type),
        );
        expect(again.error?.message).toBe('mark is frozen');
      }
      expect((await markRow(id))?.mark_type).toBe('commitment');
    });

    it('a decision mark is frozen', async () => {
      const id = await groupMessage();
      const set = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'decision'),
      );
      expect(set.error).toBeNull();
      const again = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending', 1),
      );
      expect(again.error?.message).toBe('mark is frozen');
    });

    it('priority applies to pending only', async () => {
      const id = await groupMessage();
      const res = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'decision', 1),
      );
      expect(res.error?.message).toBe('priority applies to pending only');
      expect(await markRow(id)).toBeUndefined();
    });

    it('pending: priority changes, retyping raises, resolve works once then freezes', async () => {
      const id = await groupMessage();
      const set = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending', 1),
      );
      expect(set.error).toBeNull();
      expect((await markRow(id))?.priority).toBe(1);

      // Any member may change the priority of an open pending mark.
      const bump = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending', 2),
      );
      expect(bump.error).toBeNull();
      expect((await markRow(id))?.priority).toBe(2);

      const clear = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending'),
      );
      expect(clear.error).toBeNull();
      expect((await markRow(id))?.priority).toBeNull();

      const retype = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'decision'),
      );
      expect(retype.error?.message).toBe('one mark per message');
      expect((await markRow(id))?.mark_type).toBe('pending');

      // Resolvable by any member (not only the marker), exactly once.
      const resolved = await clientFor(owner.id).rpc(
        'chat_mark_resolve',
        markResolveArgs(id, ctx.channelId),
      );
      expect(resolved.error).toBeNull();
      const row = await markRow(id);
      expect(row?.resolved_by).toBe(owner.id);
      expect(row?.resolved_at).not.toBeNull();

      const second = await clientFor(userB.id).rpc(
        'chat_mark_resolve',
        markResolveArgs(id, ctx.channelId),
      );
      expect(second.error?.message).toBe('no open mark on this message');

      const afterResolve = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending', 1),
      );
      expect(afterResolve.error?.message).toBe('mark is frozen');
    });

    it('a message from another channel is message not found', async () => {
      const res = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(dmMessageId, ctx.channelId, 'pending'),
      );
      expect(res.error?.message).toBe('message not found');
    });

    it('non-members cannot mark or resolve', async () => {
      const id = await groupMessage();
      for (const user of [userC, outsider]) {
        const set = await clientFor(user.id).rpc(
          'chat_mark_set',
          markSetArgs(id, ctx.channelId, 'pending'),
        );
        expect(set.error?.message).toBe('not a member of this chat');
      }
      expect(await markRow(id)).toBeUndefined();

      const open = await clientFor(userB.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending'),
      );
      expect(open.error).toBeNull();
      const resolve = await clientFor(userC.id).rpc(
        'chat_mark_resolve',
        markResolveArgs(id, ctx.channelId),
      );
      expect(resolve.error?.message).toBe('not a member of this chat');
      expect((await markRow(id))?.resolved_at).toBeNull();
    });

    it('SELECT is gated by chat_channel_member', async () => {
      const groupId = await groupMessage();
      const dmId = await seedMessage(adminGeneric, dmChannelId, wsA.id, userB.id);
      expect(
        (
          await clientFor(owner.id).rpc(
            'chat_mark_set',
            markSetArgs(groupId, ctx.channelId, 'decision'),
          )
        ).error,
      ).toBeNull();
      expect(
        (
          await clientFor(owner.id).rpc(
            'chat_mark_set',
            markSetArgs(dmId, dmChannelId, 'commitment'),
          )
        ).error,
      ).toBeNull();

      for (const [messageId, members] of [
        [groupId, [ownerClient, bClient]],
        [dmId, [ownerClient, bClient]],
      ] as const) {
        const match: MatchSpec = [['message_id', messageId]];
        expect(await countWhere(adminGeneric, 'chat_message_marks', match)).toBe(1);
        for (const client of members)
          expect(await ownReadCount(client, 'chat_message_marks', match)).toBe(1);
        expect(await visibleRowCount(cClient, 'chat_message_marks', match)).toBe(0);
        expect(await visibleRowCount(outsiderClient, 'chat_message_marks', match)).toBe(0);
      }
    });

    it('direct INSERT as authenticated is denied even for a channel member', async () => {
      const id = await groupMessage();
      const res = await authInsert(bClient, 'chat_message_marks', {
        message_id: id,
        channel_id: ctx.channelId,
        workspace_id: wsA.id,
        mark_type: 'decision',
      });
      expect(res.ok && res.count > 0).toBe(false);
      expect(await markRow(id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 11. chat_message_delete
  // -------------------------------------------------------------------------

  describe('chat_message_delete', () => {
    async function deletedAt(id: string): Promise<string | null> {
      const res = await adminGeneric.from('chat_messages').select('deleted_at').eq('id', id);
      if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
      const rows = (res.data as { deleted_at: string | null }[] | null) ?? [];
      if (rows.length !== 1) throw new Error(`expected one chat_messages row for ${id}`);
      return rows[0]?.deleted_at ?? null;
    }

    // Rows the 30 minute window still reaches.
    function recentMessage(senderId: string): Promise<string> {
      return seedMessage(adminGeneric, ctx.channelId, wsA.id, senderId, minutesAgo(1));
    }

    it('soft-deletes the caller own messages', async () => {
      const a = await recentMessage(userB.id);
      const b = await recentMessage(userB.id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([a, b], ctx.channelId),
      );
      expect(res.error).toBeNull();
      expect(await deletedAt(a)).not.toBeNull();
      expect(await deletedAt(b)).not.toBeNull();
      // Deleted rows stay member-visible as tombstones with every content column wiped.
      const wiped = await bClient
        .from('chat_messages')
        .select(
          'body, mentions, attachment_asset_ids, attachment_meta, shared_post_ids, shared_brief_ids',
        )
        .eq('id', a);
      expect(wiped.error).toBeNull();
      expect(wiped.data).toEqual([
        {
          body: null,
          mentions: null,
          attachment_asset_ids: null,
          attachment_meta: null,
          shared_post_ids: null,
          shared_brief_ids: null,
        },
      ]);
      expect(await visibleRowCount(ownerClient, 'chat_messages', [['id', a]])).toBe(1);
      expect(await visibleRowCount(outsiderClient, 'chat_messages', [['id', a]])).toBe(0);
    });

    it("raises on another member's message and deletes nothing", async () => {
      const own = await recentMessage(userB.id);
      const theirs = await recentMessage(owner.id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([own, theirs], ctx.channelId),
      );
      expect(res.error?.message).toBe(
        'only your own messages from the last 30 minutes can be deleted',
      );
      // The whole call rolls back, including the caller's own message.
      expect(await deletedAt(own)).toBeNull();
      expect(await deletedAt(theirs)).toBeNull();
    });

    it('raises on a marked message, even the caller own', async () => {
      const id = await seedMessage(adminGeneric, ctx.channelId, wsA.id, userB.id);
      const mark = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending'),
      );
      expect(mark.error).toBeNull();
      const res = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([id], ctx.channelId),
      );
      expect(res.error?.message).toBe('marked messages cannot be deleted');
      expect(await deletedAt(id)).toBeNull();
    });

    it('raises for a non-member and for an empty selection', async () => {
      const id = await seedMessage(adminGeneric, ctx.channelId, wsA.id, owner.id);
      const res = await clientFor(userC.id).rpc(
        'chat_message_delete',
        deleteArgs([id], ctx.channelId),
      );
      expect(res.error?.message).toBe('not a member of this chat');
      expect(await deletedAt(id)).toBeNull();

      const empty = await clientFor(owner.id).rpc(
        'chat_message_delete',
        deleteArgs([], ctx.channelId),
      );
      expect(empty.error?.message).toBe('select between 1 and 100 messages');
    });

    it('raises after the 30 minute window and deletes nothing', async () => {
      const old = await seedMessage(adminGeneric, ctx.channelId, wsA.id, userB.id, minutesAgo(40));
      const res = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([old], ctx.channelId),
      );
      expect(res.error?.message).toBe(
        'only your own messages from the last 30 minutes can be deleted',
      );
      expect(await deletedAt(old)).toBeNull();
    });

    it("chat_reaction_add raises 'message deleted' on a tombstone and adds nothing", async () => {
      const id = await recentMessage(userB.id);
      const del = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([id], ctx.channelId),
      );
      expect(del.error).toBeNull();
      const emoji = `r${randomSuffix()}`;
      const res = await clientFor(owner.id).rpc(
        'chat_reaction_add',
        reactionArgs(id, ctx.channelId, emoji),
      );
      expect(res.error?.message).toBe('message deleted');
      expect(
        await countWhere(adminGeneric, 'chat_reactions', [
          ['message_id', id],
          ['emoji', emoji],
        ]),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 11b. chat_message_edit
  // -------------------------------------------------------------------------

  describe('chat_message_edit', () => {
    interface EditedRow {
      body: string | null;
      edited_at: string | null;
    }

    async function editedRow(id: string): Promise<EditedRow> {
      const res = await adminGeneric.from('chat_messages').select('body, edited_at').eq('id', id);
      if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
      const rows = (res.data as EditedRow[] | null) ?? [];
      const row = rows[0];
      if (rows.length !== 1 || !row) throw new Error(`expected one chat_messages row for ${id}`);
      return row;
    }

    function messageAt(senderId: string, minutes: number): Promise<string> {
      return seedMessage(adminGeneric, ctx.channelId, wsA.id, senderId, minutesAgo(minutes));
    }

    it('edits the caller own message inside the window and sets edited_at', async () => {
      const id = await messageAt(userB.id, 1);
      const res = await clientFor(userB.id).rpc(
        'chat_message_edit',
        editArgs(id, ctx.channelId, 'edited body'),
      );
      expect(res.error).toBeNull();
      expect(res.data?.body).toBe('edited body');
      expect(res.data?.edited_at).not.toBeNull();
      const row = await editedRow(id);
      expect(row.body).toBe('edited body');
      expect(row.edited_at).not.toBeNull();
    });

    it("raises on another member's message and leaves it unchanged", async () => {
      const id = await messageAt(owner.id, 1);
      const before = await editedRow(id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_edit',
        editArgs(id, ctx.channelId, 'not mine'),
      );
      expect(res.error?.message).toBe('only your own messages in this chat can be edited');
      expect(await editedRow(id)).toEqual(before);
    });

    it('raises after the 15 minute window', async () => {
      const id = await messageAt(userB.id, 20);
      const before = await editedRow(id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_edit',
        editArgs(id, ctx.channelId, 'too late'),
      );
      expect(res.error?.message).toBe('edit window has closed');
      expect(await editedRow(id)).toEqual(before);
    });

    it('raises on a marked message', async () => {
      const id = await messageAt(userB.id, 1);
      const mark = await clientFor(owner.id).rpc(
        'chat_mark_set',
        markSetArgs(id, ctx.channelId, 'pending'),
      );
      expect(mark.error).toBeNull();
      const before = await editedRow(id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_edit',
        editArgs(id, ctx.channelId, 'marked'),
      );
      expect(res.error?.message).toBe('marked messages cannot be edited');
      expect(await editedRow(id)).toEqual(before);
    });

    it('raises on a deleted message', async () => {
      const id = await messageAt(userB.id, 1);
      const del = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([id], ctx.channelId),
      );
      expect(del.error).toBeNull();
      const before = await editedRow(id);
      const res = await clientFor(userB.id).rpc(
        'chat_message_edit',
        editArgs(id, ctx.channelId, 'gone'),
      );
      expect(res.error?.message).toBe('deleted messages cannot be edited');
      expect(await editedRow(id)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // 12. chat_message_send forward
  // -------------------------------------------------------------------------

  describe('chat_message_send forward', () => {
    it('raises when the sender cannot read the source', async () => {
      // userC is in the owner/userC DM (seeded by the unread-counts block) but
      // not in the owner/userB DM that holds the source.
      const [lo, hi] = owner.id < userC.id ? [owner.id, userC.id] : [userC.id, owner.id];
      const ownerCDm = `dm__${wsA.id}__${lo}__${hi}`;
      const args = sendArgs(ownerCDm, 'fwd', { forwardedFrom: dmMessageId });
      const res = await clientFor(userC.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('forward source not accessible');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
    });

    it('raises when the source is in another workspace', async () => {
      // owner joins the other workspace and reads a DM there, so only the
      // workspace check can reject the forward.
      await seedMember(adminGeneric, wsOther, owner, 'agency');
      const otherDm = await seedDmChannel(adminGeneric, wsOther.id, outsider, owner);
      const source = await seedMessage(adminGeneric, otherDm, wsOther.id, outsider.id);
      expect(await visibleRowCount(ownerClient, 'chat_messages', [['id', source]])).toBe(1);

      const args = sendArgs(ctx.channelId, 'fwd', { forwardedFrom: source });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('forward source not accessible');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
    });

    it('stores forwarded_from_message_id when the source is readable', async () => {
      const args = sendArgs(ctx.channelId, 'fwd', { forwardedFrom: dmMessageId });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.id).toBe(args.p_id);
      expect(res.data?.forwarded_from_message_id).toBe(dmMessageId);
    });
  });

  // -------------------------------------------------------------------------
  // 13. chat_channel_clear
  // -------------------------------------------------------------------------

  describe('chat_channel_clear', () => {
    it('hides older rows for the caller only; later rows stay visible', async () => {
      const older = await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id);
      const channel: MatchSpec = [['channel_id', dmChannelId]];
      const ownerBefore = await visibleRowCount(ownerClient, 'chat_messages', channel);
      expect(ownerBefore).toBeGreaterThanOrEqual(2);
      expect(await visibleRowCount(bClient, 'chat_messages', channel)).toBe(ownerBefore);

      const clear = await clientFor(userB.id).rpc('chat_channel_clear', clearArgs(dmChannelId));
      expect(clear.error).toBeNull();

      // The caller sees nothing at or before cleared_at.
      expect(await visibleRowCount(bClient, 'chat_messages', channel)).toBe(0);
      expect(await visibleRowCount(bClient, 'chat_messages', [['id', older]])).toBe(0);

      const after = await clientFor(owner.id).rpc(
        'chat_message_send',
        sendArgs(dmChannelId, 'after clear'),
      );
      expect(after.error).toBeNull();
      const afterId = after.data?.id ?? '';
      expect(await visibleRowCount(bClient, 'chat_messages', channel)).toBe(1);
      expect(await visibleRowCount(bClient, 'chat_messages', [['id', afterId]])).toBe(1);

      // The other participant still sees everything, old and new.
      expect(await visibleRowCount(ownerClient, 'chat_messages', channel)).toBe(ownerBefore + 1);
      expect(await visibleRowCount(ownerClient, 'chat_messages', [['id', older]])).toBe(1);
    });

    it('raises for a non-member', async () => {
      const res = await clientFor(userC.id).rpc('chat_channel_clear', clearArgs(dmChannelId));
      expect(res.error?.message).toBe('not a member of this chat');
    });
  });

  // -------------------------------------------------------------------------
  // 14. Table grants: authenticated SELECT reaches RLS
  // -------------------------------------------------------------------------

  describe('chat table grants: authenticated SELECT', () => {
    /** Direct SELECT as a channel member: no permission-denied error. */
    async function memberSelect(client: GenericClient, table: string, match: MatchSpec) {
      let q = client.from(table).select('*');
      for (const [column, value] of match) q = q.eq(column, value);
      const res = await q;
      expect(res.error).toBeNull();
      return (res.data as unknown[] | null) ?? [];
    }

    it('chat_message_marks: a member can SELECT; a non-member reads zero rows', async () => {
      const id = await seedMessage(adminGeneric, ctx.channelId, wsA.id, owner.id);
      await insertRow(adminGeneric, 'chat_message_marks', {
        message_id: id,
        channel_id: ctx.channelId,
        workspace_id: wsA.id,
        mark_type: 'decision',
      });
      const match: MatchSpec = [['message_id', id]];
      expect(await memberSelect(bClient, 'chat_message_marks', match)).toHaveLength(1);
      expect(await visibleRowCount(cClient, 'chat_message_marks', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_message_marks', match)).toBe(0);
    });

    it('chat_reactions: a member can SELECT; a non-member reads zero rows', async () => {
      const id = await seedMessage(adminGeneric, ctx.channelId, wsA.id, owner.id);
      await insertRow(adminGeneric, 'chat_reactions', {
        message_id: id,
        channel_id: ctx.channelId,
        workspace_id: wsA.id,
        user_id: owner.id,
        emoji: 'grant',
      });
      const match: MatchSpec = [['message_id', id]];
      expect(await memberSelect(bClient, 'chat_reactions', match)).toHaveLength(1);
      expect(await visibleRowCount(cClient, 'chat_reactions', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_reactions', match)).toBe(0);
    });

    it('chat_read_cursors: a member can SELECT; a non-member reads zero rows', async () => {
      const seeded = await admin.from('chat_read_cursors').upsert({
        channel_id: ctx.channelId,
        user_id: userB.id,
        workspace_id: wsA.id,
        last_read_message_id: ctx.chatMessageId,
        last_read_at: partitionTimestamp,
      });
      expect(seeded.error).toBeNull();
      const match: MatchSpec = [
        ['channel_id', ctx.channelId],
        ['user_id', userB.id],
      ];
      expect(await memberSelect(bClient, 'chat_read_cursors', match)).toHaveLength(1);
      expect(await visibleRowCount(cClient, 'chat_read_cursors', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_read_cursors', match)).toBe(0);
    });

    it('chat_channel_clears: a member can SELECT; a non-member reads zero rows', async () => {
      // '-infinity' records a clear row without hiding any message from the owner.
      const seeded = await admin.from('chat_channel_clears').upsert({
        channel_id: ctx.channelId,
        user_id: owner.id,
        workspace_id: wsA.id,
        cleared_at: '-infinity',
      });
      expect(seeded.error).toBeNull();
      const match: MatchSpec = [
        ['channel_id', ctx.channelId],
        ['user_id', owner.id],
      ];
      expect(await memberSelect(ownerClient, 'chat_channel_clears', match)).toHaveLength(1);
      expect(await visibleRowCount(cClient, 'chat_channel_clears', match)).toBe(0);
      expect(await visibleRowCount(outsiderClient, 'chat_channel_clears', match)).toBe(0);
    });
  });
  // -------------------------------------------------------------------------
  // 15. Mentions
  // -------------------------------------------------------------------------

  describe('chat mentions', () => {
    interface MentionEntry {
      user_id: string;
      workspace_id: string;
      event_type: string;
      entity_type: string | null;
      entity_id: string | null;
      scope: string;
      scope_key: string | null;
      tier: string;
      payload: { message_id?: string } | null;
      actor_user_id: string | null;
      deleted_at: string | null;
    }

    /** Every 'mention' inbox row for `messageId`, live or soft-deleted, via the service role. */
    async function mentionEntries(messageId: string): Promise<MentionEntry[]> {
      const res = await adminGeneric
        .from('inbox_entries')
        .select('*')
        .eq('event_type', 'mention')
        .eq('payload->>message_id', messageId);
      if (res.error) throw new Error(`inbox_entries read failed: ${res.error.message}`);
      return (res.data as MentionEntry[] | null) ?? [];
    }

    async function storedMentions(messageId: string): Promise<unknown> {
      const res = await adminGeneric.from('chat_messages').select('mentions').eq('id', messageId);
      if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
      const rows = (res.data as { mentions: unknown }[] | null) ?? [];
      if (rows.length !== 1) throw new Error(`expected one chat_messages row for ${messageId}`);
      return rows[0]?.mentions ?? null;
    }

    function live(entries: MentionEntry[], userId: string): MentionEntry[] {
      return entries.filter((e) => e.user_id === userId && e.deleted_at === null);
    }

    it('T1 group send mentioning a member stores the mention and one urgent groups entry', async () => {
      const args = sendArgs(ctx.channelId, 'hi @b', { mentions: [userB.id] });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(res.data?.mentions).toEqual([userB.id]);
      expect(await storedMentions(args.p_id)).toEqual([userB.id]);

      const entries = await mentionEntries(args.p_id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        user_id: userB.id,
        workspace_id: wsA.id,
        event_type: 'mention',
        entity_type: 'chat_channel',
        entity_id: ctx.channelId,
        scope: 'groups',
        scope_key: ctx.channelId,
        tier: 'urgent',
        payload: { message_id: args.p_id },
        actor_user_id: owner.id,
        deleted_at: null,
      });
    });

    it('T2 DM send mentioning the other party uses scope people', async () => {
      const args = sendArgs(dmChannelId, 'hi @b', { mentions: [userB.id] });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      const entries = await mentionEntries(args.p_id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        user_id: userB.id,
        entity_id: dmChannelId,
        scope: 'people',
        scope_key: dmChannelId,
        tier: 'urgent',
      });
    });

    it('T3 mentioning a same-workspace non-member raises and writes nothing', async () => {
      const args = sendArgs(ctx.channelId, 'hi @c', { mentions: [userC.id] });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('mentioned people must be in this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
      expect(await mentionEntries(args.p_id)).toHaveLength(0);
    });

    it('T4 mentioning a user from another workspace raises and writes nothing', async () => {
      const args = sendArgs(ctx.channelId, 'hi @o', { mentions: [outsider.id] });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error?.message).toBe('mentioned people must be in this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
      expect(await mentionEntries(args.p_id)).toHaveLength(0);
    });

    it('T5 strips a self mention and collapses duplicates; self-only stores null', async () => {
      const args = sendArgs(ctx.channelId, 'dupes', {
        mentions: [owner.id, userB.id, userB.id],
      });
      const res = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(res.error).toBeNull();
      expect(await storedMentions(args.p_id)).toEqual([userB.id]);
      const entries = await mentionEntries(args.p_id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.user_id).toBe(userB.id);

      const self = sendArgs(ctx.channelId, 'me', { mentions: [owner.id] });
      const selfRes = await clientFor(owner.id).rpc('chat_message_send', self);
      expect(selfRes.error).toBeNull();
      expect(selfRes.data?.mentions).toBeNull();
      expect(await storedMentions(self.p_id)).toBeNull();
      expect(await mentionEntries(self.p_id)).toHaveLength(0);
    });

    it('T6 rejects a non-array p_mentions and more than 50 mentions', async () => {
      const obj = sendArgs(ctx.channelId, 'bad', { mentions: { user: userB.id } });
      const objRes = await clientFor(owner.id).rpc('chat_message_send', obj);
      expect(objRes.error?.message).toBe('mentions must be a list of people');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', obj.p_id]])).toBe(0);

      const many = Array.from({ length: 51 }, () => crypto.randomUUID());
      const big = sendArgs(ctx.channelId, 'many', { mentions: many });
      const bigRes = await clientFor(owner.id).rpc('chat_message_send', big);
      expect(bigRes.error?.message).toBe('too many mentions');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', big.p_id]])).toBe(0);
    });

    it('T7 a resend with the same p_id keeps exactly one entry per mentioned user', async () => {
      const args = sendArgs(ctx.channelId, 'once', { mentions: [userB.id] });
      const first = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(first.error).toBeNull();
      const retry: SendArgs = { ...args, p_trace_id: generateTraceId() };
      const again = await clientFor(owner.id).rpc('chat_message_send', retry);
      expect(again.error).toBeNull();
      expect(again.data?.id).toBe(args.p_id);
      const entries = await mentionEntries(args.p_id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.user_id).toBe(userB.id);
    });

    it('T8 edit drops removed mentions, adds new ones, and keeps unchanged ones single', async () => {
      const args = sendArgs(ctx.channelId, 'hi @b', { mentions: [userB.id] });
      const sent = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(sent.error).toBeNull();
      expect(live(await mentionEntries(args.p_id), userB.id)).toHaveLength(1);

      // Remove: the entry is soft-deleted and the stored mentions go null.
      const removed = await clientFor(owner.id).rpc(
        'chat_message_edit',
        editArgs(args.p_id, ctx.channelId, 'hi', []),
      );
      expect(removed.error).toBeNull();
      expect(removed.data?.mentions).toBeNull();
      const afterRemove = await mentionEntries(args.p_id);
      expect(afterRemove).toHaveLength(1);
      expect(afterRemove[0]?.deleted_at).not.toBeNull();

      // Add: a new live entry alongside the soft-deleted one.
      const added = await clientFor(owner.id).rpc(
        'chat_message_edit',
        editArgs(args.p_id, ctx.channelId, 'hi again @b', [userB.id]),
      );
      expect(added.error).toBeNull();
      expect(added.data?.mentions).toEqual([userB.id]);
      const afterAdd = await mentionEntries(args.p_id);
      expect(afterAdd).toHaveLength(2);
      expect(live(afterAdd, userB.id)).toHaveLength(1);

      // Unchanged: the live entry is kept as is, nothing new is written.
      const liveBefore = live(afterAdd, userB.id);
      const same = await clientFor(owner.id).rpc(
        'chat_message_edit',
        editArgs(args.p_id, ctx.channelId, 'still @b', [userB.id]),
      );
      expect(same.error).toBeNull();
      const afterSame = await mentionEntries(args.p_id);
      expect(afterSame).toHaveLength(2);
      expect(live(afterSame, userB.id)).toEqual(liveBefore);
    });

    it('T9 delete soft-deletes every mention entry for the message', async () => {
      const args = sendArgs(ctx.channelId, 'hi @b', { mentions: [userB.id] });
      const sent = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(sent.error).toBeNull();
      expect(live(await mentionEntries(args.p_id), userB.id)).toHaveLength(1);

      const del = await clientFor(owner.id).rpc(
        'chat_message_delete',
        deleteArgs([args.p_id], ctx.channelId),
      );
      expect(del.error).toBeNull();
      const entries = await mentionEntries(args.p_id);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.deleted_at !== null)).toBe(true);
    });

    it('T10 only the mentioned user reads the entry through RLS', async () => {
      const args = sendArgs(ctx.channelId, 'hi @b', { mentions: [userB.id] });
      const sent = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(sent.error).toBeNull();
      const match: MatchSpec = [
        ['event_type', 'mention'],
        ['payload->>message_id', args.p_id],
      ];
      expect(await countWhere(adminGeneric, 'inbox_entries', match)).toBe(1);
      expect(await ownReadCount(bClient, 'inbox_entries', match)).toBe(1);
      expect(await visibleRowCount(ownerClient, 'inbox_entries', match)).toBe(0);
      expect(await visibleRowCount(cClient, 'inbox_entries', match)).toBe(0);
    });

    it('T11 authenticated cannot execute chat_mentions_resolve', async () => {
      const args: ResolveArgs = {
        p_channel_id: ctx.channelId,
        p_actor: owner.id,
        p_mentions: [userB.id],
      };
      const res = await clientFor(owner.id).rpc('chat_mentions_resolve', args);
      expect(res.data).toBeNull();
      expect(res.error?.message).toMatch(/permission denied/);
    });

    it('T12 the 4-arg chat_message_edit call (no p_mentions) still works', async () => {
      const id = await seedMessage(adminGeneric, ctx.channelId, wsA.id, userB.id, minutesAgo(1));
      const args = editArgs(id, ctx.channelId, 'four args');
      expect(Object.keys(args).sort()).toEqual([
        'p_body',
        'p_channel_id',
        'p_message_id',
        'p_trace_id',
      ]);
      const res = await clientFor(userB.id).rpc('chat_message_edit', args);
      expect(res.error).toBeNull();
      expect(res.data?.body).toBe('four args');
      expect(res.data?.mentions).toBeNull();
      expect(res.data?.edited_at).not.toBeNull();
    });

    it('T13 a 4-arg edit on a message WITH mentions clears them and retracts every entry', async () => {
      const args = sendArgs(ctx.channelId, 'hi @b', { mentions: [userB.id] });
      const sent = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(sent.error).toBeNull();
      expect(live(await mentionEntries(args.p_id), userB.id)).toHaveLength(1);

      const edit = editArgs(args.p_id, ctx.channelId, 'hi, no mention now');
      expect(edit).not.toHaveProperty('p_mentions');
      const res = await clientFor(owner.id).rpc('chat_message_edit', edit);
      expect(res.error).toBeNull();
      expect(res.data?.mentions).toBeNull();
      expect(await storedMentions(args.p_id)).toBeNull();
      const entries = await mentionEntries(args.p_id);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.deleted_at !== null)).toBe(true);
    });

    it('T14 one edit that removes X, keeps Y and adds Z', async () => {
      // Two more group members (seeded with the existing helpers): X = userB, Y, Z.
      const y = await seedUser(loadRlsEnv(), admin);
      const z = await seedUser(loadRlsEnv(), admin);
      extraUsers.push(y, z);
      for (const member of [y, z]) {
        await seedMember(adminGeneric, wsA, member, 'agency');
        await insertRow(adminGeneric, 'group_members', {
          group_id: ctx.groupId,
          user_id: member.id,
          workspace_id: wsA.id,
        });
      }

      const args = sendArgs(ctx.channelId, 'hi @x @y', { mentions: [userB.id, y.id] });
      const sent = await clientFor(owner.id).rpc('chat_message_send', args);
      expect(sent.error).toBeNull();
      const before = await mentionEntries(args.p_id);
      expect(live(before, userB.id)).toHaveLength(1);
      const yBefore = live(before, y.id);
      expect(yBefore).toHaveLength(1);

      const res = await clientFor(owner.id).rpc(
        'chat_message_edit',
        editArgs(args.p_id, ctx.channelId, 'hi @y @z', [y.id, z.id]),
      );
      expect(res.error).toBeNull();
      expect([...((res.data?.mentions as string[] | null) ?? [])].sort()).toEqual(
        [y.id, z.id].sort(),
      );

      const after = await mentionEntries(args.p_id);
      // X retracted.
      expect(live(after, userB.id)).toHaveLength(0);
      expect(after.filter((e) => e.user_id === userB.id).every((e) => e.deleted_at !== null)).toBe(
        true,
      );
      // Y kept as the same single live entry.
      expect(live(after, y.id)).toEqual(yBefore);
      // Z added once.
      const zLive = live(after, z.id);
      expect(zLive).toHaveLength(1);
      expect(zLive[0]).toMatchObject({
        entity_type: 'chat_channel',
        entity_id: ctx.channelId,
        scope: 'groups',
        tier: 'urgent',
        payload: { message_id: args.p_id },
        actor_user_id: owner.id,
      });
    });

    describe('@all', () => {
      // A group of its own, so earlier tests' extra members never change who
      // @all reaches: owner (sender), userB and p (active), q (inactive).
      let allChannelId: string;
      let p: SeededUser;
      let q: SeededUser;

      beforeAll(async () => {
        p = await seedUser(loadRlsEnv(), admin);
        q = await seedUser(loadRlsEnv(), admin);
        extraUsers.push(p, q);
        await seedMember(adminGeneric, wsA, p, 'agency');
        await seedMember(adminGeneric, wsA, q, 'client');
        const group = await insertRow(adminGeneric, 'groups', {
          workspace_id: wsA.id,
          name: `All ${randomSuffix()}`,
          created_by: owner.id,
        });
        allChannelId = `group__${wsA.id}__${String(group.id)}`;
        await insertRow(adminGeneric, 'chat_channels', {
          channel_id: allChannelId,
          workspace_id: wsA.id,
          channel_type: 'group',
          entity_id: group.id,
        });
        for (const member of [owner, userB, p, q]) {
          await insertRow(adminGeneric, 'group_members', {
            group_id: group.id,
            user_id: member.id,
            workspace_id: wsA.id,
          });
        }
        const deactivated = await adminGeneric
          .from('workspace_members')
          .update({ active: false })
          .eq('workspace_id', wsA.id)
          .eq('user_id', q.id);
        expect(deactivated.error).toBeNull();
      });

      it('T15 @all notifies every active group member except the sender, one entry each', async () => {
        const args = sendArgs(allChannelId, 'standup @all', { mentions: ['all'] });
        const res = await clientFor(owner.id).rpc('chat_message_send', args);
        expect(res.error).toBeNull();
        expect([...((res.data?.mentions as string[] | null) ?? [])].sort()).toEqual(
          [userB.id, p.id].sort(),
        );
        const entries = await mentionEntries(args.p_id);
        expect(live(entries, userB.id)).toHaveLength(1);
        expect(live(entries, p.id)).toHaveLength(1);
        expect(live(entries, owner.id)).toHaveLength(0);
        expect(entries.filter((e) => e.deleted_at === null)).toHaveLength(2);
        expect(live(entries, p.id)[0]).toMatchObject({
          entity_type: 'chat_channel',
          entity_id: allChannelId,
          scope: 'groups',
          tier: 'urgent',
          payload: { message_id: args.p_id },
          actor_user_id: owner.id,
        });
      });

      it('T16 @all plus a named member: no duplicate entry', async () => {
        const args = sendArgs(allChannelId, '@all and @b', { mentions: ['all', userB.id] });
        const res = await clientFor(owner.id).rpc('chat_message_send', args);
        expect(res.error).toBeNull();
        const entries = await mentionEntries(args.p_id);
        expect(live(entries, userB.id)).toHaveLength(1);
        expect(live(entries, p.id)).toHaveLength(1);
        expect(entries.filter((e) => e.deleted_at === null)).toHaveLength(2);
      });

      it("T17 @all in a DM raises 'everyone mention works only in groups'", async () => {
        const args = sendArgs(dmChannelId, 'hey @all', { mentions: ['all'] });
        const res = await clientFor(owner.id).rpc('chat_message_send', args);
        expect(res.error?.message).toMatch(/everyone mention works only in groups/);
        expect(await countWhere(adminGeneric, 'chat_messages', [['id', args.p_id]])).toBe(0);
      });

      it('T18 an edit removing @all retracts every entry except people still named', async () => {
        const args = sendArgs(allChannelId, '@all ship it', { mentions: ['all'] });
        const sent = await clientFor(owner.id).rpc('chat_message_send', args);
        expect(sent.error).toBeNull();
        const before = await mentionEntries(args.p_id);
        const pBefore = live(before, p.id);
        expect(pBefore).toHaveLength(1);
        expect(live(before, userB.id)).toHaveLength(1);

        const res = await clientFor(owner.id).rpc(
          'chat_message_edit',
          editArgs(args.p_id, allChannelId, '@p ship it', [p.id]),
        );
        expect(res.error).toBeNull();
        expect(res.data?.mentions).toEqual([p.id]);
        const after = await mentionEntries(args.p_id);
        expect(live(after, userB.id)).toHaveLength(0);
        expect(
          after.filter((e) => e.user_id === userB.id).every((e) => e.deleted_at !== null),
        ).toBe(true);
        expect(live(after, p.id)).toEqual(pBefore);
      });

      it('T19 an inactive workspace member in the group gets no entry and causes no error', async () => {
        const args = sendArgs(allChannelId, '@all heads up', { mentions: ['all'] });
        const res = await clientFor(owner.id).rpc('chat_message_send', args);
        expect(res.error).toBeNull();
        expect(res.data?.mentions as string[] | null).not.toContain(q.id);
        const entries = await mentionEntries(args.p_id);
        expect(entries.filter((e) => e.user_id === q.id)).toHaveLength(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 16. Thread root
  // -------------------------------------------------------------------------

  describe('chat thread root', () => {
    interface ReplyCountRow {
      root_id: string;
      reply_count: number;
      last_reply_at: string;
    }

    /** thread_root_message_id of one row, read through the service role. */
    async function threadRoot(id: string): Promise<string | null> {
      const res = await adminGeneric
        .from('chat_messages')
        .select('thread_root_message_id')
        .eq('id', id);
      if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
      const rows = (res.data as { thread_root_message_id: string | null }[] | null) ?? [];
      if (rows.length !== 1) throw new Error(`expected one chat_messages row for ${id}`);
      return rows[0]?.thread_root_message_id ?? null;
    }

    /** Send as userB in the group channel and return the new id. */
    async function send(body: string, replyTo?: string): Promise<string> {
      const args = sendArgs(ctx.channelId, body, replyTo ? { replyTo } : {});
      const res = await clientFor(userB.id).rpc('chat_message_send', args);
      if (res.error) throw new Error(`chat_message_send failed: ${res.error.message}`);
      return args.p_id;
    }

    function countArgs(rootIds: string[]): ThreadCountArgs {
      return { p_trace_id: generateTraceId(), p_channel_id: ctx.channelId, p_root_ids: rootIds };
    }

    async function replyCounts(userId: string, rootIds: string[]): Promise<ReplyCountRow[]> {
      const res = await clientFor(userId).rpc('chat_thread_reply_counts', countArgs(rootIds));
      if (res.error) throw new Error(`chat_thread_reply_counts failed: ${res.error.message}`);
      return res.data ?? [];
    }

    it('T1 a reply to a top-level message is rooted at that message', async () => {
      const top = await send('top');
      const reply = await send('reply', top);
      expect(await threadRoot(reply)).toBe(top);
    });

    it('T2 a reply to a reply is rooted at the top-level message, not the middle', async () => {
      const top = await send('top');
      const middle = await send('middle', top);
      const leaf = await send('leaf', middle);
      expect(await threadRoot(middle)).toBe(top);
      expect(await threadRoot(leaf)).toBe(top);
    });

    it('T3 a non-reply has a null root', async () => {
      const top = await send('standalone');
      expect(await threadRoot(top)).toBeNull();
    });

    it('T4 a reply to a deleted (tombstone) middle message still inherits the top-level root', async () => {
      const top = await send('top');
      const middle = await send('middle', top);
      const del = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([middle], ctx.channelId),
      );
      expect(del.error).toBeNull();
      const leaf = await send('leaf', middle);
      expect(await threadRoot(leaf)).toBe(top);
    });

    it('T5 chat_thread_reply_counts: member counts, deleted skipped, non-member empty, first 200 ids only', async () => {
      const top = await send('top');
      const r1 = await send('r1', top);
      const r2 = await send('r2', r1);
      const r3 = await send('r3', top);
      const del = await clientFor(userB.id).rpc(
        'chat_message_delete',
        deleteArgs([r3], ctx.channelId),
      );
      expect(del.error).toBeNull();
      const other = await send('other top');
      await send('other reply', other);

      const rows = await replyCounts(owner.id, [top, other]);
      const byRoot = new Map(rows.map((r) => [r.root_id, r]));
      expect(rows).toHaveLength(2);
      // r3 is a tombstone: only r1 and r2 count.
      expect(byRoot.get(top)?.reply_count).toBe(2);
      expect(byRoot.get(other)?.reply_count).toBe(1);
      const r2Row = await adminGeneric.from('chat_messages').select('created_at').eq('id', r2);
      const r2CreatedAt = (r2Row.data as { created_at: string }[] | null)?.[0]?.created_at;
      expect(Date.parse(byRoot.get(top)?.last_reply_at ?? '')).toBe(Date.parse(r2CreatedAt ?? ''));

      // userC is a workspace member outside the group channel: RLS hides every row.
      expect(await replyCounts(userC.id, [top, other])).toEqual([]);
      expect(await replyCounts(outsider.id, [top, other])).toEqual([]);

      // Only the first 200 ids are read: the real root at position 201 is ignored.
      const filler = Array.from({ length: 200 }, () => crypto.randomUUID());
      expect(await replyCounts(owner.id, [...filler, top])).toEqual([]);
      const inside = await replyCounts(owner.id, [...filler.slice(0, 199), top]);
      expect(inside.map((r) => [r.root_id, r.reply_count])).toEqual([[top, 2]]);
    });

    it('T7 chat_thread_reply_counts with p_since: anon refused, authenticated counts from p_since, other workspace zero rows', async () => {
      const top = await send('top since');
      await send('since r1', top);
      await send('since r2', top);
      const topRow = await adminGeneric.from('chat_messages').select('created_at').eq('id', top);
      const topCreatedAt = (topRow.data as { created_at: string }[] | null)?.[0]?.created_at ?? '';
      expect(topCreatedAt).not.toBe('');
      const sinceArgs = (rootIds: string[], since: string): ThreadCountSinceArgs => ({
        p_trace_id: generateTraceId(),
        p_channel_id: ctx.channelId,
        p_root_ids: rootIds,
        p_since: since,
      });

      // anon has no EXECUTE on the 4-arg function.
      const anon = createAnonClient(loadRlsEnv());
      const refused = await anon.rpc('chat_thread_reply_counts', sinceArgs([top], topCreatedAt));
      expect(refused.error).not.toBeNull();
      expect(refused.data ?? []).toEqual([]);

      // authenticated member: p_since = the root's created_at loses no reply.
      const member = await clientFor(owner.id).rpc(
        'chat_thread_reply_counts',
        sinceArgs([top], topCreatedAt),
      );
      expect(member.error).toBeNull();
      expect((member.data ?? []).map((r) => [r.root_id, Number(r.reply_count)])).toEqual([
        [top, 2],
      ]);
      // '-infinity' reads unbounded below: the same answer.
      const unbounded = await clientFor(owner.id).rpc(
        'chat_thread_reply_counts',
        sinceArgs([top], '-infinity'),
      );
      expect((unbounded.data ?? []).map((r) => Number(r.reply_count))).toEqual([2]);
      // A p_since after every reply counts none.
      const later = new Date(Date.parse(topCreatedAt) + 86_400_000).toISOString();
      const after = await clientFor(owner.id).rpc(
        'chat_thread_reply_counts',
        sinceArgs([top], later),
      );
      expect(after.error).toBeNull();
      expect(after.data ?? []).toEqual([]);

      // A caller from another workspace: zero rows (chat_messages RLS applies).
      const cross = await clientFor(outsider.id).rpc(
        'chat_thread_reply_counts',
        sinceArgs([top], topCreatedAt),
      );
      expect(cross.error).toBeNull();
      expect(cross.data ?? []).toEqual([]);
    });

    it('T6 a client cannot set the root through chat_message_send; a cross-channel reply_to is still refused', async () => {
      // The generated Args carry no thread root parameter.
      type HasRootParam = 'p_thread_root_message_id' extends keyof SendArgs ? true : false;
      const hasRootParam: HasRootParam = false;
      expect(hasRootParam).toBe(false);

      // Supplying one anyway matches no function signature and inserts nothing.
      const top = await send('top');
      const forged = {
        ...sendArgs(ctx.channelId, 'forged', { replyTo: top }),
        p_thread_root_message_id: dmMessageId,
      };
      const res = await clientFor(userB.id).rpc('chat_message_send', forged);
      expect(res.error).not.toBeNull();
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', forged.p_id]])).toBe(0);

      // A reply target in another channel (the DM) is refused by the existing check.
      const cross = sendArgs(ctx.channelId, 'cross', { replyTo: dmMessageId });
      const crossRes = await clientFor(userB.id).rpc('chat_message_send', cross);
      expect(crossRes.error?.message).toBe('reply target not in this chat');
      expect(await countWhere(adminGeneric, 'chat_messages', [['id', cross.p_id]])).toBe(0);
    });
  });
});
