// member_invite_check and workspace_update (20261015038000_workspace_update_invite_check.sql),
// recorded from live. member_invite_check runs every invite permission and email check and
// writes nothing; member_invite now delegates its checks to it. workspace_update lets an
// owner or admin (workspace.manage_settings) edit name, logo_url and timezone only; platform
// and any other key are invalid_payload.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  loadRlsEnv,
  randomSuffix,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database, Json } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/**
 * Typed pass-through for direct .rpc() args. workspace_update takes its own
 * p_trace_id (a uuid v7, set at every call site); member_invite_check takes none.
 * callRpc() is the app wrapper and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

interface WorkspaceRow {
  name: string;
  logo_url: string | null;
  timezone: string;
  platform: string;
  client_domain: string | null;
  row_version: number;
}

describe.runIf(RLS_SUITE)('member_invite_check and workspace_update', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  async function newWorkspace(clientDomain: string | null): Promise<SeededWorkspace> {
    const w = await seedWorkspace(admin, owner, `IC ${randomSuffix()}`);
    workspaces.push(w);
    if (clientDomain !== null) {
      const rv = (await readWorkspace(w.id)).row_version;
      const res = await g
        .from('workspaces')
        .update({ client_domain: clientDomain, row_version: rv + 1 })
        .eq('id', w.id);
      if (res.error) throw new Error(res.error.message);
    }
    return w;
  }

  async function memberOf(
    w: SeededWorkspace,
    role: 'admin' | 'agency' | 'client',
  ): Promise<SeededUser> {
    const u = await seedUser(env, admin);
    users.push(u);
    await seedMember(g, w, u, role);
    return u;
  }

  async function readWorkspace(id: string): Promise<WorkspaceRow> {
    const res = await admin
      .from('workspaces')
      .select('name, logo_url, timezone, platform, client_domain, row_version')
      .eq('id', id)
      .single();
    if (res.error) throw new Error(res.error.message);
    const row = res.data as unknown as WorkspaceRow;
    return { ...row, row_version: Number(row.row_version) };
  }

  async function check(by: SeededUser, wsId: string, email: string, role: string) {
    return await clientFor(by.id).rpc(
      'member_invite_check',
      rpcArgs({ p_workspace_id: wsId, p_email: email, p_role: role }),
    );
  }

  async function update(by: SeededUser, wsId: string, payload: Json) {
    return await clientFor(by.id).rpc(
      'workspace_update',
      rpcArgs({ p_workspace_id: wsId, p_payload: payload, p_trace_id: uuidv7() }),
    );
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    users.push(owner);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  describe('member_invite_check', () => {
    it('passes for the owner inviting an agency member', async () => {
      const w = await newWorkspace(null);
      const res = await check(owner, w.id, `ag_${randomSuffix()}@agency.example`, 'agency');
      expect(res.error).toBeNull();
    });

    it('refuses a client inviter adding an agency member (forbidden_role)', async () => {
      const w = await newWorkspace('hinglish.com');
      const client = await memberOf(w, 'client');
      const res = await check(client, w.id, `ag_${randomSuffix()}@hinglish.com`, 'agency');
      expect(res.error?.message).toBe('forbidden_role');
    });

    it('refuses free mail for a client (free_mail_client)', async () => {
      const w = await newWorkspace(null);
      const res = await check(owner, w.id, `c_${randomSuffix()}@gmail.com`, 'client');
      expect(res.error?.message).toBe('free_mail_client');
    });

    it('refuses a client outside the workspace domain (client_domain_mismatch)', async () => {
      const w = await newWorkspace('hinglish.com');
      const res = await check(owner, w.id, `c_${randomSuffix()}@english.com`, 'client');
      expect(res.error?.message).toBe('client_domain_mismatch');
    });

    it('refuses a non-member (workspace_member_only)', async () => {
      const w = await newWorkspace(null);
      const outsider = await seedUser(env, admin);
      users.push(outsider);
      const res = await check(outsider, w.id, `ag_${randomSuffix()}@agency.example`, 'agency');
      expect(res.error?.message).toBe('workspace_member_only');
    });

    it('writes nothing: client_domain and row_version unchanged after a passing client check', async () => {
      const w = await newWorkspace(null);
      const before = await readWorkspace(w.id);
      expect(before.client_domain).toBeNull();
      const res = await check(owner, w.id, `c_${randomSuffix()}@hinglish.com`, 'client');
      expect(res.error).toBeNull();
      const after = await readWorkspace(w.id);
      expect(after.client_domain).toBeNull();
      expect(after.row_version).toBe(before.row_version);
      const members = await admin
        .from('workspace_members')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', w.id);
      expect(members.count).toBe(1);
    });
  });

  describe('workspace_update', () => {
    it('owner and admin succeed', async () => {
      const w = await newWorkspace(null);
      expect((await update(owner, w.id, { name: 'Owner Name' })).error).toBeNull();
      expect((await readWorkspace(w.id)).name).toBe('Owner Name');
      const adminMember = await memberOf(w, 'admin');
      expect((await update(adminMember, w.id, { timezone: 'Asia/Kolkata' })).error).toBeNull();
      expect((await readWorkspace(w.id)).timezone).toBe('Asia/Kolkata');
    });

    it('agency and client are refused (forbidden_role)', async () => {
      const w = await newWorkspace(null);
      for (const role of ['agency', 'client'] as const) {
        const m = await memberOf(w, role);
        expect((await update(m, w.id, { name: 'Nope' })).error?.message, role).toBe(
          'forbidden_role',
        );
      }
    });

    it('trims the name and increments row_version by 1', async () => {
      const w = await newWorkspace(null);
      const before = await readWorkspace(w.id);
      expect((await update(owner, w.id, { name: '  Kite and Co  ' })).error).toBeNull();
      const after = await readWorkspace(w.id);
      expect(after.name).toBe('Kite and Co');
      expect(after.row_version).toBe(before.row_version + 1);
    });

    it('refuses an empty or 81 character name (invalid_payload)', async () => {
      const w = await newWorkspace(null);
      for (const name of ['', '   ', 'a'.repeat(81)]) {
        expect((await update(owner, w.id, { name })).error?.message, name).toBe('invalid_payload');
      }
      expect((await update(owner, w.id, { name: 'a'.repeat(80) })).error).toBeNull();
    });

    it('refuses the platform key and any unknown key (invalid_payload)', async () => {
      const w = await newWorkspace(null);
      const before = await readWorkspace(w.id);
      expect((await update(owner, w.id, { platform: 'instagram' })).error?.message).toBe(
        'invalid_payload',
      );
      expect((await update(owner, w.id, { name: 'X', platform: 'x' })).error?.message).toBe(
        'invalid_payload',
      );
      expect((await update(owner, w.id, { colour: 'red' })).error?.message).toBe('invalid_payload');
      expect((await update(owner, w.id, {})).error?.message).toBe('invalid_payload');
      const after = await readWorkspace(w.id);
      expect(after.platform).toBe(before.platform);
      expect(after.row_version).toBe(before.row_version);
    });

    it('refuses an http logo and clears the logo with an empty string', async () => {
      const w = await newWorkspace(null);
      expect(
        (await update(owner, w.id, { logo_url: 'http://cdn.example/logo.png' })).error?.message,
      ).toBe('invalid_payload');
      expect(
        (await update(owner, w.id, { logo_url: 'https://cdn.example/logo.png' })).error,
      ).toBeNull();
      expect((await readWorkspace(w.id)).logo_url).toBe('https://cdn.example/logo.png');
      expect((await update(owner, w.id, { logo_url: '' })).error).toBeNull();
      expect((await readWorkspace(w.id)).logo_url).toBeNull();
    });

    it('refuses an unknown timezone (invalid_payload)', async () => {
      const w = await newWorkspace(null);
      expect((await update(owner, w.id, { timezone: 'Mars/Olympus' })).error?.message).toBe(
        'invalid_payload',
      );
    });

    it('refuses a caller from another tenant (workspace_member_only)', async () => {
      const w = await newWorkspace(null);
      const otherOwner = await seedUser(env, admin);
      users.push(otherOwner);
      const other = await seedWorkspace(admin, otherOwner, `IC other ${randomSuffix()}`);
      workspaces.push(other);
      expect((await update(otherOwner, w.id, { name: 'Hijack' })).error?.message).toBe(
        'workspace_member_only',
      );
      expect((await readWorkspace(w.id)).name).not.toBe('Hijack');
    });
  });
});
