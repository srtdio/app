// Cross-tenant checks for the speedy read paths (20261026120000_speedy_b.sql):
//
// - activity_badge_counts / activity_badge_snoozed: a user reads only their own
//   rows, and only while an active member of that workspace. Rows are written by
//   the inbox_entries statement triggers (_activity_badge_apply), so they are
//   seeded by inserting inbox_entries through the service role.
// - activity_badge_read for a workspace the caller is not in returns 0/0.
// - chat_open_bundle and plan_bundle_read on another workspace raise
//   workspace_member_only.
// - posts_list, capabilities_for_workspace and ref_resolve on another workspace
//   return no rows.
// - comment_create rejects a mention of a client on a draft post, or of a
//   non-member, with invalid_mention (DETAIL = comma-separated ids), and a post
//   outside p_workspace_id with invalid_payload.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  ownReadCount,
  partitionTimestamp,
  randomSuffix,
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

interface RpcResult {
  data?: unknown;
  error: { message: string; details?: string | null } | null;
}

interface BadgeRow {
  unread: number;
  mentions: number;
}

/**
 * Untyped rpc: these procs are newer than the generated Database types. Each
 * takes its own p_trace_id (a uuid v7, set at every call site).
 */
async function rawRpc(
  client: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const untyped = client as unknown as {
    rpc: (name: string, params: Record<string, unknown>) => PromiseLike<RpcResult>;
  };
  return await untyped.rpc(fn, args);
}

function rowsOf(res: RpcResult): unknown[] {
  if (res.error) throw new Error(`rpc failed: ${res.error.message}`);
  return Array.isArray(res.data) ? res.data : [];
}

describe.runIf(RLS_SUITE)('speedy read paths: cross-tenant isolation', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let agency: SeededUser;
  let client: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let ctx: Ctx;
  let otherCtx: Ctx;
  let wsKey: string;
  let postNumber: number;
  let draftPostId: string;

  async function seedInbox(
    userId: string,
    workspaceId: string,
    eventType: 'system' | 'mention',
    snoozedUntil: string | null = null,
  ): Promise<void> {
    await insertRow(g, 'inbox_entries', {
      user_id: userId,
      workspace_id: workspaceId,
      event_type: eventType,
      scope: 'everything',
      snoozed_until: snoozedUntil,
      created_at: partitionTimestamp,
    });
  }

  function badgeMatch(workspaceId: string, userId: string): MatchSpec {
    return [
      ['workspace_id', workspaceId],
      ['user_id', userId],
    ];
  }

  async function badgeRead(user: SeededUser, workspaceId: string): Promise<BadgeRow> {
    const rows = rowsOf(
      await rawRpc(clientFor(user.id), 'activity_badge_read', {
        p_trace_id: uuidv7(),
        p_workspace_id: workspaceId,
      }),
    ) as BadgeRow[];
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('activity_badge_read returned no row');
    return row;
  }

  function createComment(
    user: SeededUser,
    workspaceId: string,
    postId: string,
    mentions: string[],
  ): Promise<RpcResult> {
    return rawRpc(clientFor(user.id), 'comment_create', {
      p_workspace_id: workspaceId,
      p_entity_type: 'post',
      p_entity_id: postId,
      p_parent_comment_id: null,
      p_body: 'Tighten the hook',
      p_mentions: mentions,
      p_attachment_asset_ids: [],
      p_trace_id: uuidv7(),
    });
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    agency = await seedUser(env, admin);
    client = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Speedy ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Speedy other ${outsider.email}`);
    await seedMember(g, ws, agency, 'agency');
    await seedMember(g, ws, client, 'client');
    ctx = await seedScaffold(admin, ws);
    otherCtx = await seedScaffold(admin, other);

    const wsRow = await g.from('workspaces').select('key').eq('id', ws.id);
    if (wsRow.error) throw new Error(`workspaces read failed: ${wsRow.error.message}`);
    const key = (wsRow.data as { key: string }[] | null)?.[0]?.key;
    if (!key) throw new Error('workspace key missing');
    wsKey = key;
    const postRow = await g.from('posts').select('number').eq('id', ctx.postId);
    if (postRow.error) throw new Error(`posts read failed: ${postRow.error.message}`);
    const num = (postRow.data as { number: number }[] | null)?.[0]?.number;
    if (typeof num !== 'number') throw new Error('post number missing');
    postNumber = num;

    const draft = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: `Draft ${randomSuffix()}`,
      bucket_id: ctx.bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage: 'draft',
      created_by: owner.id,
    });
    draftPostId = String(draft.id);

    // Owner of ws: two unread (one mention) plus one snoozed into the future.
    await seedInbox(owner.id, ws.id, 'system');
    await seedInbox(owner.id, ws.id, 'mention');
    await seedInbox(owner.id, ws.id, 'system', '2099-01-01T00:00:00.000Z');
    // Outsider's own rows in their workspace.
    await seedInbox(outsider.id, other.id, 'mention');
    await seedInbox(outsider.id, other.id, 'system', '2099-01-01T00:00:00.000Z');
    // A row for owner in a workspace owner is NOT a member of: the badge row is
    // owner's own but the active-member clause must still hide it.
    await seedInbox(owner.id, other.id, 'mention');
    await seedInbox(owner.id, other.id, 'system', '2099-01-01T00:00:00.000Z');
  });

  afterAll(async () => {
    // The badge tables carry no FK to workspaces, so clear them explicitly.
    for (const w of [ws, other]) {
      await g.from('activity_badge_counts').delete().eq('workspace_id', w.id);
      await g.from('activity_badge_snoozed').delete().eq('workspace_id', w.id);
    }
    await cleanupWorkspaces(admin, [ws, other], [owner, agency, client, outsider]);
  });

  describe('activity_badge_counts', () => {
    it('owner reads their own row (positive control)', async () => {
      expect(
        await ownReadCount(
          asGeneric(clientFor(owner.id)),
          'activity_badge_counts',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(1);
    });

    it("another member of the same workspace cannot read the owner's row", async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(agency.id)),
          'activity_badge_counts',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(0);
    });

    it("a member of another workspace cannot read the owner's row", async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(outsider.id)),
          'activity_badge_counts',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(0);
    });

    it('a user cannot read their own row in a workspace they are not a member of', async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(owner.id)),
          'activity_badge_counts',
          badgeMatch(other.id, owner.id),
        ),
      ).toBe(0);
    });
  });

  describe('activity_badge_snoozed', () => {
    it('owner reads their own snoozed row (positive control)', async () => {
      expect(
        await ownReadCount(
          asGeneric(clientFor(owner.id)),
          'activity_badge_snoozed',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(1);
    });

    it("another member of the same workspace cannot read the owner's snoozed row", async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(agency.id)),
          'activity_badge_snoozed',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(0);
    });

    it("a member of another workspace cannot read the owner's snoozed row", async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(outsider.id)),
          'activity_badge_snoozed',
          badgeMatch(ws.id, owner.id),
        ),
      ).toBe(0);
    });

    it('a user cannot read their own snoozed row in a workspace they are not in', async () => {
      expect(
        await visibleRowCount(
          asGeneric(clientFor(owner.id)),
          'activity_badge_snoozed',
          badgeMatch(other.id, owner.id),
        ),
      ).toBe(0);
    });
  });

  describe('activity_badge_read', () => {
    it('own workspace returns the trigger-maintained counts (positive control)', async () => {
      expect(await badgeRead(owner, ws.id)).toEqual({ unread: 2, mentions: 1 });
    });

    it('a workspace the caller is not in returns 0/0', async () => {
      expect(await badgeRead(outsider, ws.id)).toEqual({ unread: 0, mentions: 0 });
    });

    it('own rows in a workspace the caller is not a member of still read 0/0', async () => {
      expect(await badgeRead(owner, other.id)).toEqual({ unread: 0, mentions: 0 });
    });
  });

  describe('chat_open_bundle', () => {
    it('own workspace channel opens (positive control)', async () => {
      const res = await rawRpc(clientFor(owner.id), 'chat_open_bundle', {
        p_trace_id: uuidv7(),
        p_workspace_id: ws.id,
        p_channel_id: ctx.channelId,
        p_since: null,
      });
      expect(res.error).toBeNull();
    });

    it('another workspace raises workspace_member_only', async () => {
      const res = await rawRpc(clientFor(outsider.id), 'chat_open_bundle', {
        p_trace_id: uuidv7(),
        p_workspace_id: ws.id,
        p_channel_id: ctx.channelId,
        p_since: null,
      });
      expect(res.error?.message).toContain('workspace_member_only');
    });

    it('own channel id paired with another workspace id raises workspace_member_only', async () => {
      const res = await rawRpc(clientFor(owner.id), 'chat_open_bundle', {
        p_trace_id: uuidv7(),
        p_workspace_id: other.id,
        p_channel_id: ctx.channelId,
        p_since: null,
      });
      expect(res.error?.message).toContain('workspace_member_only');
    });
  });

  describe('plan_bundle_read', () => {
    it('own workspace reads (positive control)', async () => {
      const res = await rawRpc(clientFor(owner.id), 'plan_bundle_read', {
        p_trace_id: uuidv7(),
        p_workspace_id: ws.id,
      });
      expect(res.error).toBeNull();
    });

    it('another workspace raises workspace_member_only', async () => {
      const res = await rawRpc(clientFor(outsider.id), 'plan_bundle_read', {
        p_trace_id: uuidv7(),
        p_workspace_id: ws.id,
      });
      expect(res.error?.message).toContain('workspace_member_only');
    });
  });

  describe('posts_list', () => {
    it('own workspace lists its posts (positive control)', async () => {
      const rows = rowsOf(
        await rawRpc(clientFor(owner.id), 'posts_list', {
          p_trace_id: uuidv7(),
          p_workspace_id: ws.id,
          p_stage: null,
          p_limit: 50,
          p_before: null,
        }),
      ) as { id: string }[];
      expect(rows.map((r) => r.id)).toContain(ctx.postId);
    });

    it('another workspace returns no rows', async () => {
      const rows = rowsOf(
        await rawRpc(clientFor(outsider.id), 'posts_list', {
          p_trace_id: uuidv7(),
          p_workspace_id: ws.id,
          p_stage: null,
          p_limit: 50,
          p_before: null,
        }),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('capabilities_for_workspace', () => {
    it('own workspace reads without error (positive control)', async () => {
      const res = await rawRpc(clientFor(owner.id), 'capabilities_for_workspace', {
        p_trace_id: uuidv7(),
        p_workspace_id: ws.id,
      });
      expect(res.error).toBeNull();
    });

    it('another workspace returns no rows', async () => {
      const rows = rowsOf(
        await rawRpc(clientFor(outsider.id), 'capabilities_for_workspace', {
          p_trace_id: uuidv7(),
          p_workspace_id: ws.id,
        }),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('ref_resolve', () => {
    it('own workspace key resolves the post (positive control)', async () => {
      const rows = rowsOf(
        await rawRpc(clientFor(owner.id), 'ref_resolve', {
          p_trace_id: uuidv7(),
          p_workspace_key: wsKey,
          p_kind: 'post',
          p_number: postNumber,
        }),
      ) as { workspace_id: string; entity_id: string | null }[];
      expect(rows).toEqual([{ workspace_id: ws.id, entity_id: ctx.postId }]);
    });

    it('another workspace key returns no rows', async () => {
      const rows = rowsOf(
        await rawRpc(clientFor(outsider.id), 'ref_resolve', {
          p_trace_id: uuidv7(),
          p_workspace_key: wsKey,
          p_kind: 'post',
          p_number: postNumber,
        }),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('comment_create mention and workspace rules', () => {
    it('mentioning a client on a draft post raises invalid_mention with the client id', async () => {
      const res = await createComment(agency, ws.id, draftPostId, [client.id]);
      expect(res.error?.message).toContain('invalid_mention');
      expect(res.error?.details ?? '').toContain(client.id);
      expect(
        await ownReadCount(g, 'comments', [
          ['entity_id', draftPostId],
          ['author_user_id', agency.id],
        ]),
      ).toBe(0);
    });

    it('mentioning a non-member raises invalid_mention with that id', async () => {
      const res = await createComment(agency, ws.id, ctx.postId, [outsider.id]);
      expect(res.error?.message).toContain('invalid_mention');
      expect(res.error?.details ?? '').toContain(outsider.id);
    });

    it('a post outside p_workspace_id raises invalid_payload', async () => {
      const res = await createComment(agency, ws.id, otherCtx.postId, []);
      expect(res.error?.message).toContain('invalid_payload');
      expect(
        await ownReadCount(g, 'comments', [
          ['entity_id', otherCtx.postId],
          ['author_user_id', agency.id],
        ]),
      ).toBe(0);
    });

    it('mentioning an agency member on a draft post succeeds (positive control)', async () => {
      const res = await createComment(agency, ws.id, draftPostId, [owner.id]);
      expect(res.error).toBeNull();
    });
  });
});
