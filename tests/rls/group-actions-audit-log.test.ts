// Group and DM actions write to audit_log (20260930150000_group_actions_audit_log.sql).
// dm_channel_ensure, group_create, group_rename, group_avatar_set,
// group_member_add, group_member_remove and group_leave each call
// public.audit_log_write after a successful change:
//
//   T1. Each action, on success, writes exactly one audit_log row carrying the
//       caller as actor, the action name, workspace, entity, the p_trace_id that
//       was passed, and the payload the proc builds.
//   T2. No-ops write nothing: DM already exists, member already in the group,
//       removing a non-member, rename to the same name, leave when not a member.
//   T3. Refused actions (group_manage_denied, member_not_in_workspace,
//       cannot_dm_self, group_not_found) write nothing and change nothing.
//   T4. group_leave by the last member still archives the group (existing
//       trigger) and writes the group_leave row.
//   T5. A workspace owner/admin who did not create the group can add, remove and
//       rename; the row's actor is that admin. A plain member is refused.
//   T6. Cross-workspace: a caller from workspace B cannot act on workspace A's
//       group, and no row is written for A.
//
// Every call carries a fresh trace id, so each assertion reads audit_log by that
// trace id through the service role (RLS-bypassing ground truth). Seeding goes
// through the service role, following the rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  generateTraceId,
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
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type Fns = Database['public']['Functions'];
type DmArgs = Fns['dm_channel_ensure']['Args'];
type CreateArgs = Fns['group_create']['Args'];
type RenameArgs = Fns['group_rename']['Args'];
type AvatarArgs = Fns['group_avatar_set']['Args'];
type MemberArgs = Fns['group_member_add']['Args'];
type LeaveArgs = Fns['group_leave']['Args'];

// Proc arguments are built here (not inline at the .rpc() call) so each call
// carries a fresh trace id the way the app's callRpc() wrapper does.
function dmArgs(workspaceId: string, otherUserId: string): DmArgs {
  return {
    p_workspace_id: workspaceId,
    p_other_user_id: otherUserId,
    p_trace_id: generateTraceId(),
  };
}

function createArgs(workspaceId: string, name: string, memberIds: string[]): CreateArgs {
  return {
    p_workspace_id: workspaceId,
    p_name: name,
    p_member_user_ids: memberIds,
    p_trace_id: generateTraceId(),
  };
}

function renameArgs(groupId: string, name: string): RenameArgs {
  return { p_group_id: groupId, p_name: name, p_trace_id: generateTraceId() };
}

function avatarArgs(groupId: string, avatarUrl: string): AvatarArgs {
  return { p_group_id: groupId, p_avatar_url: avatarUrl, p_trace_id: generateTraceId() };
}

function memberArgs(groupId: string, userId: string): MemberArgs {
  return { p_group_id: groupId, p_user_id: userId, p_trace_id: generateTraceId() };
}

function leaveArgs(groupId: string): LeaveArgs {
  return { p_group_id: groupId, p_trace_id: generateTraceId() };
}

interface AuditRow {
  actor_user_id: string | null;
  action: string;
  workspace_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  trace_id: string;
  payload: unknown;
  outcome: string;
}

/** audit_log rows carrying `traceId`, read through the service role. */
async function auditRows(admin: GenericClient, traceId: string): Promise<AuditRow[]> {
  const res = await admin
    .from('audit_log')
    .select(
      'actor_user_id, action, workspace_id, entity_type, entity_id, trace_id, payload, outcome',
    )
    .eq('trace_id', traceId);
  if (res.error) throw new Error(`audit_log read failed: ${res.error.message}`);
  return (res.data as AuditRow[] | null) ?? [];
}

/** The single audit_log row for `traceId`; fails unless there is exactly one. */
async function onlyAuditRow(admin: GenericClient, traceId: string): Promise<AuditRow> {
  const rows = await auditRows(admin, traceId);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error(`no audit_log row for trace ${traceId}`);
  return row;
}

interface GroupRow {
  name: string;
  avatar_url: string | null;
  created_by: string;
  deleted_at: string | null;
}

/** groups row read through the service role (ground truth, RLS bypassed). */
async function groupRow(admin: GenericClient, groupId: string): Promise<GroupRow> {
  const res = await admin
    .from('groups')
    .select('name, avatar_url, created_by, deleted_at')
    .eq('id', groupId);
  if (res.error) throw new Error(`groups read failed: ${res.error.message}`);
  const row = (res.data as GroupRow[] | null)?.[0];
  if (!row) throw new Error(`group ${groupId} not found`);
  return row;
}

async function memberCount(admin: GenericClient, groupId: string): Promise<number> {
  return countWhere(admin, 'group_members', [['group_id', groupId]]);
}

async function isMember(admin: GenericClient, groupId: string, userId: string): Promise<boolean> {
  const n = await countWhere(admin, 'group_members', [
    ['group_id', groupId],
    ['user_id', userId],
  ]);
  return n === 1;
}

/** Group plus its channel and one group_members row per member, created_by = creator. */
async function seedGroup(
  admin: GenericClient,
  ws: SeededWorkspace,
  creator: SeededUser,
  members: readonly SeededUser[],
): Promise<string> {
  const group = await insertRow(admin, 'groups', {
    workspace_id: ws.id,
    name: `Grp ${randomSuffix()}`,
    created_by: creator.id,
  });
  const groupId = String(group.id);
  await insertRow(admin, 'chat_channels', {
    channel_id: `group__${ws.id}__${groupId}`,
    workspace_id: ws.id,
    channel_type: 'group',
    entity_id: groupId,
  });
  for (const user of members) {
    await insertRow(admin, 'group_members', {
      group_id: groupId,
      user_id: user.id,
      workspace_id: ws.id,
    });
  }
  return groupId;
}

/** Service-role raise of workspaces.group_allowance, bumping row_version like every write. */
async function raiseGroupAllowance(
  admin: Client,
  workspaceId: string,
  allowance: number,
): Promise<void> {
  const cur = await admin.from('workspaces').select('row_version').eq('id', workspaceId).single();
  if (cur.error) throw new Error(`workspaces read failed: ${cur.error.message}`);
  const res = await admin
    .from('workspaces')
    .update({ group_allowance: allowance, row_version: cur.data.row_version + 1 })
    .eq('id', workspaceId);
  if (res.error) throw new Error(`group_allowance update failed: ${res.error.message}`);
}

/** A fresh avatar URL; groups_avatar_url_check requires an http(s) URL. */
function avatarUrlFor(): string {
  return `https://example.test/avatars/${randomSuffix()}.png`;
}

function dmChannelId(workspaceId: string, a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `dm__${workspaceId}__${lo}__${hi}`;
}

describe.runIf(RLS_SUITE)('group and DM actions write to audit_log', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: owner (role owner), wsAdmin (role admin), creator, plain,
  // memberA, memberB (all agency). Workspace B: ownerB and memberBws.
  let owner: SeededUser;
  let wsAdmin: SeededUser;
  let creator: SeededUser;
  let plain: SeededUser;
  let memberA: SeededUser;
  let memberB: SeededUser;
  let ownerB: SeededUser;
  let memberBws: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);
    owner = await seedUser(env, admin);
    wsAdmin = await seedUser(env, admin);
    creator = await seedUser(env, admin);
    plain = await seedUser(env, admin);
    memberA = await seedUser(env, admin);
    memberB = await seedUser(env, admin);
    ownerB = await seedUser(env, admin);
    memberBws = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Audit A ${owner.email}`);
    wsB = await seedWorkspace(admin, ownerB, `Audit B ${ownerB.email}`);
    await seedMember(adminGeneric, wsA, wsAdmin, 'admin');
    for (const user of [creator, plain, memberA, memberB]) {
      await seedMember(adminGeneric, wsA, user, 'agency');
    }
    await seedMember(adminGeneric, wsB, memberBws, 'agency');
    // group_create refuses with group_limit_reached once a workspace holds
    // group_allowance live groups (20261029120000_group_limit.sql), and that
    // check runs before member_not_in_workspace. This file seeds ~17 groups in
    // wsA (seedGroup plus one real group_create), so raise wsA's allowance well
    // above that; the limit itself is covered by its own spec.
    await raiseGroupAllowance(admin, wsA.id, 100);
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [wsA, wsB],
      [owner, wsAdmin, creator, plain, memberA, memberB, ownerB, memberBws],
    );
  });

  describe('T1. each action writes exactly one row on success', () => {
    it('dm_channel_ensure (new DM) writes dm_channel_create', async () => {
      const args = dmArgs(wsA.id, memberB.id);
      const res = await clientFor(memberA.id).rpc('dm_channel_ensure', args);
      expect(res.error).toBeNull();
      const channelId = dmChannelId(wsA.id, memberA.id, memberB.id);
      expect(res.data).toBe(channelId);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: memberA.id,
        action: 'dm_channel_create',
        workspace_id: wsA.id,
        entity_type: 'chat_channel',
        entity_id: channelId,
        trace_id: args.p_trace_id,
        payload: { other_user_id: memberB.id },
        outcome: 'success',
      });
    });

    it('group_create writes group_create', async () => {
      const name = `Create ${randomSuffix()}`;
      const args = createArgs(wsA.id, name, [memberA.id, memberB.id]);
      const res = await clientFor(creator.id).rpc('group_create', args);
      expect(res.error).toBeNull();
      const groupId = String(res.data);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: creator.id,
        action: 'group_create',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: { name, member_user_ids: [memberA.id, memberB.id] },
        outcome: 'success',
      });
    });

    it('group_rename writes group_rename with old and new name', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const oldName = (await groupRow(adminGeneric, groupId)).name;
      const newName = `Renamed ${randomSuffix()}`;
      const args = renameArgs(groupId, newName);
      const res = await clientFor(creator.id).rpc('group_rename', args);
      expect(res.error).toBeNull();
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: creator.id,
        action: 'group_rename',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: { old_name: oldName, new_name: newName },
        outcome: 'success',
      });
    });

    it('group_avatar_set writes group_avatar_set', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const avatarUrl = avatarUrlFor();
      const args = avatarArgs(groupId, avatarUrl);
      const res = await clientFor(creator.id).rpc('group_avatar_set', args);
      expect(res.error).toBeNull();
      expect((await groupRow(adminGeneric, groupId)).avatar_url).toBe(avatarUrl);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: creator.id,
        action: 'group_avatar_set',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: { avatar_url: avatarUrl },
        outcome: 'success',
      });
    });

    it('group_member_add writes group_member_add', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator]);
      const args = memberArgs(groupId, memberA.id);
      const res = await clientFor(creator.id).rpc('group_member_add', args);
      expect(res.error).toBeNull();
      expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(true);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: creator.id,
        action: 'group_member_add',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: { user_id: memberA.id },
        outcome: 'success',
      });
    });

    it('group_member_remove writes group_member_remove', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const args = memberArgs(groupId, memberA.id);
      const res = await clientFor(creator.id).rpc('group_member_remove', args);
      expect(res.error).toBeNull();
      expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(false);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: creator.id,
        action: 'group_member_remove',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: { user_id: memberA.id },
        outcome: 'success',
      });
    });

    it('group_leave writes group_leave', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const args = leaveArgs(groupId);
      const res = await clientFor(memberA.id).rpc('group_leave', args);
      expect(res.error).toBeNull();
      expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(false);
      const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
      expect(row).toEqual({
        actor_user_id: memberA.id,
        action: 'group_leave',
        workspace_id: wsA.id,
        entity_type: 'group',
        entity_id: groupId,
        trace_id: args.p_trace_id,
        payload: {},
        outcome: 'success',
      });
    });
  });

  describe('T2. no-ops write nothing', () => {
    it('dm_channel_ensure on an existing DM returns it and writes no row', async () => {
      const channelId = await seedDmChannel(adminGeneric, wsA.id, plain, memberB);
      const args = dmArgs(wsA.id, memberB.id);
      const res = await clientFor(plain.id).rpc('dm_channel_ensure', args);
      expect(res.error).toBeNull();
      expect(res.data).toBe(channelId);
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    });

    it('group_member_add for a member already in the group writes no row', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const args = memberArgs(groupId, memberA.id);
      const res = await clientFor(creator.id).rpc('group_member_add', args);
      expect(res.error).toBeNull();
      expect(await memberCount(adminGeneric, groupId)).toBe(2);
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    });

    it('group_member_remove of a non-member writes no row', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const args = memberArgs(groupId, memberB.id);
      const res = await clientFor(creator.id).rpc('group_member_remove', args);
      expect(res.error).toBeNull();
      expect(await memberCount(adminGeneric, groupId)).toBe(2);
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    });

    it('group_rename to the same name writes no row', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const name = (await groupRow(adminGeneric, groupId)).name;
      const args = renameArgs(groupId, name);
      const res = await clientFor(creator.id).rpc('group_rename', args);
      expect(res.error).toBeNull();
      expect((await groupRow(adminGeneric, groupId)).name).toBe(name);
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    });

    it('group_leave when not a member writes no row', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
      const args = leaveArgs(groupId);
      const res = await clientFor(memberB.id).rpc('group_leave', args);
      expect(res.error).toBeNull();
      expect(await memberCount(adminGeneric, groupId)).toBe(2);
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    });
  });

  describe('T3. refused actions write nothing and change nothing', () => {
    it('group_manage_denied: a plain member cannot rename, set avatar, add or remove', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, plain, memberA]);
      const before = await groupRow(adminGeneric, groupId);

      const rename = renameArgs(groupId, `Nope ${randomSuffix()}`);
      const renameRes = await clientFor(plain.id).rpc('group_rename', rename);
      expect(renameRes.error?.message).toContain('group_manage_denied');

      const avatar = avatarArgs(groupId, avatarUrlFor());
      const avatarRes = await clientFor(plain.id).rpc('group_avatar_set', avatar);
      expect(avatarRes.error?.message).toContain('group_manage_denied');

      const add = memberArgs(groupId, memberB.id);
      const addRes = await clientFor(plain.id).rpc('group_member_add', add);
      expect(addRes.error?.message).toContain('group_manage_denied');

      const remove = memberArgs(groupId, memberA.id);
      const removeRes = await clientFor(plain.id).rpc('group_member_remove', remove);
      expect(removeRes.error?.message).toContain('group_manage_denied');

      for (const args of [rename, avatar, add, remove]) {
        expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      }
      const after = await groupRow(adminGeneric, groupId);
      expect(after.name).toBe(before.name);
      expect(after.avatar_url).toBe(before.avatar_url);
      expect(await isMember(adminGeneric, groupId, memberB.id)).toBe(false);
      expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(true);
      expect(await memberCount(adminGeneric, groupId)).toBe(3);
    });

    it('member_not_in_workspace: adding a user from another workspace', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator]);
      const args = memberArgs(groupId, memberBws.id);
      const res = await clientFor(creator.id).rpc('group_member_add', args);
      expect(res.error?.message).toContain('member_not_in_workspace');
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      expect(await memberCount(adminGeneric, groupId)).toBe(1);
    });

    it('member_not_in_workspace: group_create with an outside member creates nothing', async () => {
      const name = `Refused ${randomSuffix()}`;
      const args = createArgs(wsA.id, name, [memberA.id, memberBws.id]);
      const res = await clientFor(creator.id).rpc('group_create', args);
      expect(res.error?.message).toContain('member_not_in_workspace');
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      expect(
        await countWhere(adminGeneric, 'groups', [
          ['workspace_id', wsA.id],
          ['name', name],
        ]),
      ).toBe(0);
    });

    it('member_not_in_workspace: dm_channel_ensure with an outside user', async () => {
      const args = dmArgs(wsA.id, memberBws.id);
      const res = await clientFor(memberA.id).rpc('dm_channel_ensure', args);
      expect(res.error?.message).toContain('member_not_in_workspace');
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      const channelId = dmChannelId(wsA.id, memberA.id, memberBws.id);
      expect(await countWhere(adminGeneric, 'chat_channels', [['channel_id', channelId]])).toBe(0);
    });

    it('cannot_dm_self: dm_channel_ensure with yourself', async () => {
      const args = dmArgs(wsA.id, memberA.id);
      const res = await clientFor(memberA.id).rpc('dm_channel_ensure', args);
      expect(res.error?.message).toContain('cannot_dm_self');
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      const channelId = dmChannelId(wsA.id, memberA.id, memberA.id);
      expect(await countWhere(adminGeneric, 'chat_channels', [['channel_id', channelId]])).toBe(0);
    });

    it('group_not_found: acting on a group id that does not exist', async () => {
      const missing = crypto.randomUUID();
      const rename = renameArgs(missing, `Ghost ${randomSuffix()}`);
      const avatar = avatarArgs(missing, avatarUrlFor());
      const add = memberArgs(missing, memberA.id);
      const remove = memberArgs(missing, memberA.id);
      const results = [
        await clientFor(owner.id).rpc('group_rename', rename),
        await clientFor(owner.id).rpc('group_avatar_set', avatar),
        await clientFor(owner.id).rpc('group_member_add', add),
        await clientFor(owner.id).rpc('group_member_remove', remove),
      ];
      for (const res of results) expect(res.error?.message).toContain('group_not_found');
      for (const args of [rename, avatar, add, remove]) {
        expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
      }
      expect(await countWhere(adminGeneric, 'groups', [['id', missing]])).toBe(0);
      expect(await countWhere(adminGeneric, 'group_members', [['group_id', missing]])).toBe(0);
    });
  });

  it('T4. group_leave by the last member archives the group and writes group_leave', async () => {
    const groupId = await seedGroup(adminGeneric, wsA, creator, [memberA]);
    expect((await groupRow(adminGeneric, groupId)).deleted_at).toBeNull();
    const args = leaveArgs(groupId);
    const res = await clientFor(memberA.id).rpc('group_leave', args);
    expect(res.error).toBeNull();
    expect(await memberCount(adminGeneric, groupId)).toBe(0);
    expect((await groupRow(adminGeneric, groupId)).deleted_at).not.toBeNull();
    const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
    expect(row).toEqual({
      actor_user_id: memberA.id,
      action: 'group_leave',
      workspace_id: wsA.id,
      entity_type: 'group',
      entity_id: groupId,
      trace_id: args.p_trace_id,
      payload: {},
      outcome: 'success',
    });
  });

  describe('T5. workspace owner/admin who did not create the group', () => {
    for (const who of ['owner', 'admin'] as const) {
      it(`${who} can add, remove and rename; the row actor is the ${who}`, async () => {
        const actor = who === 'owner' ? owner : wsAdmin;
        const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
        expect((await groupRow(adminGeneric, groupId)).created_by).not.toBe(actor.id);
        expect(await isMember(adminGeneric, groupId, actor.id)).toBe(false);

        const add = memberArgs(groupId, memberB.id);
        expect((await clientFor(actor.id).rpc('group_member_add', add)).error).toBeNull();
        expect(await isMember(adminGeneric, groupId, memberB.id)).toBe(true);

        const remove = memberArgs(groupId, memberA.id);
        expect((await clientFor(actor.id).rpc('group_member_remove', remove)).error).toBeNull();
        expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(false);

        const newName = `Admin ${randomSuffix()}`;
        const rename = renameArgs(groupId, newName);
        expect((await clientFor(actor.id).rpc('group_rename', rename)).error).toBeNull();
        expect((await groupRow(adminGeneric, groupId)).name).toBe(newName);

        const expected: ReadonlyArray<readonly [MemberArgs | RenameArgs, string]> = [
          [add, 'group_member_add'],
          [remove, 'group_member_remove'],
          [rename, 'group_rename'],
        ];
        for (const [args, action] of expected) {
          const row = await onlyAuditRow(adminGeneric, args.p_trace_id);
          expect(row.actor_user_id).toBe(actor.id);
          expect(row.action).toBe(action);
          expect(row.workspace_id).toBe(wsA.id);
          expect(row.entity_id).toBe(groupId);
          expect(row.trace_id).toBe(args.p_trace_id);
        }
      });
    }

    it('a plain member who did not create the group gets group_manage_denied', async () => {
      const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, plain]);
      const add = memberArgs(groupId, memberB.id);
      const res = await clientFor(plain.id).rpc('group_member_add', add);
      expect(res.error?.message).toContain('group_manage_denied');
      expect(await auditRows(adminGeneric, add.p_trace_id)).toHaveLength(0);
      expect(await isMember(adminGeneric, groupId, memberB.id)).toBe(false);
    });
  });

  it("T6. a caller from workspace B cannot act on workspace A's group; no row for A", async () => {
    const groupId = await seedGroup(adminGeneric, wsA, creator, [creator, memberA]);
    const before = await groupRow(adminGeneric, groupId);
    const auditBefore = await countWhere(adminGeneric, 'audit_log', [['workspace_id', wsA.id]]);

    const rename = renameArgs(groupId, `Cross ${randomSuffix()}`);
    const avatar = avatarArgs(groupId, avatarUrlFor());
    const add = memberArgs(groupId, memberBws.id);
    const remove = memberArgs(groupId, memberA.id);
    const leave = leaveArgs(groupId);
    const dm = dmArgs(wsA.id, memberA.id);
    const b = clientFor(ownerB.id);
    const refused = [
      await b.rpc('group_rename', rename),
      await b.rpc('group_avatar_set', avatar),
      await b.rpc('group_member_add', add),
      await b.rpc('group_member_remove', remove),
      await b.rpc('dm_channel_ensure', dm),
    ];
    for (const res of refused) expect(res.error).not.toBeNull();
    // group_leave by a non-member is a silent no-op, not an error.
    expect((await b.rpc('group_leave', leave)).error).toBeNull();

    for (const args of [rename, avatar, add, remove, leave, dm]) {
      expect(await auditRows(adminGeneric, args.p_trace_id)).toHaveLength(0);
    }
    expect(await countWhere(adminGeneric, 'audit_log', [['workspace_id', wsA.id]])).toBe(
      auditBefore,
    );
    const after = await groupRow(adminGeneric, groupId);
    expect(after.name).toBe(before.name);
    expect(after.avatar_url).toBe(before.avatar_url);
    expect(await memberCount(adminGeneric, groupId)).toBe(2);
    expect(await isMember(adminGeneric, groupId, memberA.id)).toBe(true);
  });
});
