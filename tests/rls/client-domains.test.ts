// Approver email rule and client-invites-client (20261015037000_workspace_client_domains.sql),
// recorded from live; rule as of 20261023100000_invite_free_mail_exact_domain_role_set.sql.
// For role client, member_invite allows free mail; otherwise the invitee domain must equal or
// be a subdomain of workspaces.client_domain, or of an active owner-approved
// workspace_client_domains row; anything else is client_domain_mismatch. A client inviter may invite only clients.
// Only the workspace owner adds or removes approved domains; removal is soft.

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
  seedOperator,
  seedWorkspace,
  type GenericClient,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/**
 * Typed pass-through for direct .rpc() args. Each proc here takes its own
 * p_trace_id (a uuid v7, set at every call site). callRpc() is the app wrapper
 * and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

describe.runIf(RLS_SUITE)('approver email rule and workspace_client_domains', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];
  const domainUserIds: string[] = [];

  /** An auth user with a chosen email domain (seedUser always uses example.test). */
  async function emailAt(domain: string): Promise<string> {
    const email = `cd_${randomSuffix()}@${domain}`;
    const created = await admin.auth.admin.createUser({
      email,
      password: `Pw_${crypto.randomUUID()}`,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser failed: ${created.error?.message ?? 'no user'}`);
    }
    domainUserIds.push(created.data.user.id);
    return email;
  }

  async function newWorkspace(clientDomain: string | null): Promise<SeededWorkspace> {
    const w = await seedWorkspace(admin, owner, `CD ${randomSuffix()}`);
    workspaces.push(w);
    if (clientDomain !== null) {
      const cur = await admin.from('workspaces').select('row_version').eq('id', w.id).single();
      if (cur.error) throw new Error(cur.error.message);
      const rv = Number((cur.data as { row_version: number }).row_version);
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

  async function invite(by: SeededUser, wsId: string, email: string, role: string) {
    return await clientFor(by.id).rpc(
      'member_invite',
      rpcArgs({ p_workspace_id: wsId, p_email: email, p_role: role, p_trace_id: uuidv7() }),
    );
  }

  async function inviteAt(wsId: string, domain: string) {
    return await invite(owner, wsId, await emailAt(domain), 'client');
  }

  async function addDomain(by: SeededUser, wsId: string, domain: string) {
    return await clientFor(by.id).rpc(
      'workspace_client_domain_add',
      rpcArgs({ p_workspace_id: wsId, p_domain: domain, p_trace_id: uuidv7() }),
    );
  }

  async function removeDomain(by: SeededUser, wsId: string, domain: string) {
    return await clientFor(by.id).rpc(
      'workspace_client_domain_remove',
      rpcArgs({ p_workspace_id: wsId, p_domain: domain, p_trace_id: uuidv7() }),
    );
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    // Fixture owner of several workspaces: exempt from the one-workspace-per-owner
    // trigger (20261016000000_workspace_owner_limit.sql) as an active platform operator.
    await seedOperator(asGeneric(admin), owner);
    users.push(owner);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
    for (const id of domainUserIds) await admin.auth.admin.deleteUser(id);
  });

  describe('client inviter', () => {
    it('a client inviting a client passes the domain rule like an owner', async () => {
      const w = await newWorkspace('hinglish.com');
      const client = await memberOf(w, 'client');
      const ok = await invite(client, w.id, await emailAt('hinglish.com'), 'client');
      expect(ok.error).toBeNull();
      const bad = await invite(client, w.id, await emailAt('hinglish.in'), 'client');
      expect(bad.error?.message).toBe('client_domain_mismatch');
      const free = await invite(client, w.id, await emailAt('outlook.com'), 'client');
      expect(free.error).toBeNull();
    });

    it('a client cannot invite an agency, admin or owner member (forbidden_role)', async () => {
      const w = await newWorkspace('hinglish.com');
      const client = await memberOf(w, 'client');
      for (const role of ['agency', 'admin', 'owner']) {
        const res = await invite(client, w.id, await emailAt('hinglish.com'), role);
        expect(res.error?.message).toBe('forbidden_role');
      }
    });
  });

  describe('exact client domain rule', () => {
    let w: SeededWorkspace;

    beforeAll(async () => {
      w = await newWorkspace('hinglish.com');
    });

    it('allows free mail for a client, outlook.com included', async () => {
      for (const domain of ['gmail.com', 'outlook.com']) {
        const res = await inviteAt(w.id, domain);
        expect(res.error, domain).toBeNull();
      }
    });

    it('refuses other endings, co.in style endings, longer brand words and their subdomains (client_domain_mismatch)', async () => {
      for (const domain of [
        'english.com',
        'hindustantimes.com',
        'hinglish.in',
        'hinglish.co.in',
        'hinglishh.com',
        'hinglish-ads.in',
        'mail.hinglish.in',
      ]) {
        const res = await inviteAt(w.id, domain);
        expect(res.error?.message, domain).toBe('client_domain_mismatch');
      }
    });

    it('allows the exact client domain and its subdomains', async () => {
      for (const domain of ['hinglish.com', 'mail.hinglish.com']) {
        const res = await inviteAt(w.id, domain);
        expect(res.error, domain).toBeNull();
      }
    });

    it('needs the exact domain for a short brand word too', async () => {
      const short = await newWorkspace('kia.com');
      const longer = await inviteAt(short.id, 'kiaads.com');
      expect(longer.error?.message).toBe('client_domain_mismatch');
      const otherEnding = await inviteAt(short.id, 'kia.co.in');
      expect(otherEnding.error?.message).toBe('client_domain_mismatch');
      const exact = await inviteAt(short.id, 'kia.com');
      expect(exact.error).toBeNull();
    });
  });

  describe('owner-approved domains', () => {
    it('admits an approved domain and its subdomains, refuses it once removed, admits it again after re-add', async () => {
      const w = await newWorkspace('hinglish.com');
      expect((await inviteAt(w.id, 'partneragency.in')).error?.message).toBe(
        'client_domain_mismatch',
      );

      const added = await addDomain(owner, w.id, 'PartnerAgency.in');
      expect(added.error).toBeNull();
      expect((await inviteAt(w.id, 'partneragency.in')).error).toBeNull();
      expect((await inviteAt(w.id, 'team.partneragency.in')).error).toBeNull();

      const removed = await removeDomain(owner, w.id, 'partneragency.in');
      expect(removed.error).toBeNull();
      const row = await admin
        .from('workspace_client_domains')
        .select('id, removed_at, removed_by')
        .eq('workspace_id', w.id)
        .eq('domain', 'partneragency.in')
        .single();
      expect((row.data as { removed_at: string | null }).removed_at).not.toBeNull();
      expect((row.data as { removed_by: string | null }).removed_by).toBe(owner.id);
      expect((await inviteAt(w.id, 'partneragency.in')).error?.message).toBe(
        'client_domain_mismatch',
      );

      const readded = await addDomain(owner, w.id, 'partneragency.in');
      expect(readded.error).toBeNull();
      expect(readded.data).toBe((row.data as { id: string }).id);
      const after = await admin
        .from('workspace_client_domains')
        .select('removed_at, removed_by')
        .eq('id', String(readded.data))
        .single();
      expect(after.data).toEqual({ removed_at: null, removed_by: null });
      expect((await inviteAt(w.id, 'partneragency.in')).error).toBeNull();
    });

    it('lets only the owner add or remove (forbidden_role)', async () => {
      const w = await newWorkspace('hinglish.com');
      expect((await addDomain(owner, w.id, 'partner-two.in')).error).toBeNull();
      for (const role of ['admin', 'agency', 'client'] as const) {
        const m = await memberOf(w, role);
        expect((await addDomain(m, w.id, 'other-partner.in')).error?.message, role).toBe(
          'forbidden_role',
        );
        expect((await removeDomain(m, w.id, 'partner-two.in')).error?.message, role).toBe(
          'forbidden_role',
        );
      }
    });

    it('refuses free mail (free_mail_client) and a malformed domain (invalid_payload)', async () => {
      const w = await newWorkspace(null);
      expect((await addDomain(owner, w.id, 'outlook.com')).error?.message).toBe('free_mail_client');
      expect((await addDomain(owner, w.id, 'not a domain')).error?.message).toBe('invalid_payload');
    });

    it('refuses to remove a domain with nothing active (not_found)', async () => {
      const w = await newWorkspace(null);
      expect((await removeDomain(owner, w.id, 'never-added.in')).error?.message).toBe('not_found');
      expect((await addDomain(owner, w.id, 'once-added.in')).error).toBeNull();
      expect((await removeDomain(owner, w.id, 'once-added.in')).error).toBeNull();
      expect((await removeDomain(owner, w.id, 'once-added.in')).error?.message).toBe('not_found');
    });
  });

  describe('RLS', () => {
    it('members see their workspace rows; another tenant sees nothing', async () => {
      const w = await newWorkspace(null);
      expect((await addDomain(owner, w.id, 'tenant-a.in')).error).toBeNull();
      const member = await memberOf(w, 'client');
      const own = await clientFor(member.id)
        .from('workspace_client_domains')
        .select('domain')
        .eq('workspace_id', w.id);
      expect(own.data).toEqual([{ domain: 'tenant-a.in' }]);

      const otherOwner = await seedUser(env, admin);
      users.push(otherOwner);
      const other = await seedWorkspace(admin, otherOwner, `CD other ${randomSuffix()}`);
      workspaces.push(other);
      const cross = await clientFor(otherOwner.id).from('workspace_client_domains').select('id');
      expect(cross.error).toBeNull();
      expect(cross.data).toEqual([]);
    });

    it('cannot be written directly by authenticated users', async () => {
      const w = await newWorkspace(null);
      const res = await asGeneric(clientFor(owner.id))
        .from('workspace_client_domains')
        .insert({ workspace_id: w.id, domain: 'direct.in', approved_by: owner.id });
      expect(res.error).not.toBeNull();
    });
  });
});
