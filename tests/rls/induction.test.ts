// Induction schema (20261015030000..20261015036000), recorded from live.
// member_invite client email rules: free mail refused (free_mail_client), a set
// client_domain admits its brand word and subdomains (client_domain_mismatch
// otherwise; full approver rule in client-domains.test.ts), and a workspace that already has clients but no client_domain is unaffected.
// post_create takes the platform from the workspace and refuses formats that
// platform does not offer (invalid_format). brand_agency_request caps an open
// request at 5 sends and is fulfilled when its sender is invited as a client.
// induction_step_set validates the step format. workspace_create and
// member_accept write one welcome (system) inbox row each.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  insertRow,
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

interface DomainUser {
  user: SeededUser;
  client: SupabaseClient<Database>;
}

describe.runIf(RLS_SUITE)('induction schema', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let ws: SeededWorkspace;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];
  const domainUsers: DomainUser[] = [];

  /** A signed-in user with a chosen email domain (seedUser always uses example.test). */
  async function seedUserAt(domain: string): Promise<DomainUser> {
    const email = `ind_${randomSuffix()}@${domain}`;
    const password = `Pw_${crypto.randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) {
      throw new Error(`createUser failed: ${created.error?.message ?? 'no user'}`);
    }
    const client = createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn failed: ${signIn.error.message}`);
    const du = { user: { id: created.data.user.id, email, password }, client };
    domainUsers.push(du);
    return du;
  }

  async function newWorkspace(): Promise<SeededWorkspace> {
    const w = await seedWorkspace(admin, owner, `Ind ${randomSuffix()}`);
    workspaces.push(w);
    return w;
  }

  async function setClientDomain(wsId: string, domain: string | null): Promise<void> {
    const cur = await admin.from('workspaces').select('row_version').eq('id', wsId).single();
    if (cur.error) throw new Error(cur.error.message);
    const rv = Number((cur.data as { row_version: number }).row_version);
    const res = await g
      .from('workspaces')
      .update({ client_domain: domain, row_version: rv + 1 })
      .eq('id', wsId);
    if (res.error) throw new Error(res.error.message);
  }

  async function clientDomainOf(wsId: string): Promise<string | null> {
    const res = await admin.from('workspaces').select('client_domain').eq('id', wsId).single();
    if (res.error) throw new Error(res.error.message);
    return (res.data as { client_domain: string | null }).client_domain;
  }

  async function invite(wsId: string, email: string, role: string) {
    return await clientFor(owner.id).rpc(
      'member_invite',
      rpcArgs({ p_workspace_id: wsId, p_email: email, p_role: role, p_trace_id: uuidv7() }),
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
    ws = await newWorkspace();
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
    for (const du of domainUsers) await admin.auth.admin.deleteUser(du.user.id);
  });

  describe('member_invite client email rules', () => {
    it('refuses a free mail address for a client (free_mail_client)', async () => {
      const w = await newWorkspace();
      const res = await invite(w.id, `someone_${randomSuffix()}@gmail.com`, 'client');
      expect(res.error?.message).toBe('free_mail_client');
      expect(await clientDomainOf(w.id)).toBeNull();
    });

    it('allows a free mail address for agency members', async () => {
      const w = await newWorkspace();
      const du = await seedUserAt('gmail.com');
      const res = await invite(w.id, du.user.email, 'agency');
      expect(res.error).toBeNull();
    });

    it('records client_domain from the first client invite', async () => {
      const w = await newWorkspace();
      const du = await seedUserAt('kite-first.test');
      const res = await invite(w.id, du.user.email, 'client');
      expect(res.error).toBeNull();
      expect(await clientDomainOf(w.id)).toBe('kite-first.test');
    });

    it('refuses another domain once client_domain is set (client_domain_mismatch)', async () => {
      const w = await newWorkspace();
      await setClientDomain(w.id, 'kite.test');
      const du = await seedUserAt('other.test');
      const res = await invite(w.id, du.user.email, 'client');
      expect(res.error?.message).toBe('client_domain_mismatch');
    });

    it('allows a subdomain of client_domain', async () => {
      const w = await newWorkspace();
      await setClientDomain(w.id, 'kite.test');
      const du = await seedUserAt('team.kite.test');
      const res = await invite(w.id, du.user.email, 'client');
      expect(res.error).toBeNull();
      expect(await clientDomainOf(w.id)).toBe('kite.test');
    });

    it('leaves a workspace with existing clients and no client_domain unaffected', async () => {
      const w = await newWorkspace();
      const existing = await seedUser(env, admin);
      users.push(existing);
      await seedMember(g, w, existing, 'client');
      const du = await seedUserAt('elsewhere.test');
      const res = await invite(w.id, du.user.email, 'client');
      expect(res.error).toBeNull();
      expect(await clientDomainOf(w.id)).toBeNull();
    });
  });

  describe('post_create platform and formats', () => {
    let bucketId: string;

    beforeAll(async () => {
      const bucket = await insertRow(g, 'workspace_buckets', {
        workspace_id: ws.id,
        name: `B ${randomSuffix()}`,
        color_hex: '#123456',
      });
      bucketId = String(bucket.id);
    });

    it('refuses a format the workspace platform does not offer (invalid_format)', async () => {
      const res = await clientFor(owner.id).rpc(
        'post_create',
        rpcArgs({
          p_workspace_id: ws.id,
          p_payload: { title: 'Reel on LinkedIn', format: 'reel', bucket_id: bucketId },
          p_trace_id: uuidv7(),
        }),
      );
      expect(res.error?.message).toBe('invalid_format');
    });

    it('takes the platform from the workspace and ignores the payload platform', async () => {
      const res = await clientFor(owner.id).rpc(
        'post_create',
        rpcArgs({
          p_workspace_id: ws.id,
          p_payload: { title: 'Text post', format: 'text', platform: 'x', bucket_id: bucketId },
          p_trace_id: uuidv7(),
        }),
      );
      expect(res.error).toBeNull();
      const post = await admin.from('posts').select('platform').eq('id', String(res.data)).single();
      expect((post.data as { platform: string }).platform).toBe('linkedin');
    });
  });

  describe('brand_agency_request', () => {
    it('caps an open request at 5 sends (too_many_requests)', async () => {
      const du = await seedUserAt('brand-cap.test');
      const send = async () =>
        await du.client.rpc(
          'brand_agency_request',
          rpcArgs({
            p_agency_email: 'hello@agency.test',
            p_brand_name: 'Brand',
            p_trace_id: uuidv7(),
          }),
        );
      for (let i = 0; i < 5; i++) {
        const res = await send();
        expect(res.error).toBeNull();
      }
      const sixth = await send();
      expect(sixth.error?.message).toBe('too_many_requests');
      const own = await du.client
        .from('brand_agency_requests')
        .select('send_count, fulfilled_at')
        .eq('requested_by', du.user.id);
      expect(own.data).toEqual([{ send_count: 5, fulfilled_at: null }]);
    });

    it('is fulfilled when its sender is invited as a client', async () => {
      const w = await newWorkspace();
      const du = await seedUserAt('brand-fulfil.test');
      const req = await du.client.rpc(
        'brand_agency_request',
        rpcArgs({ p_agency_email: 'hi@agency.test', p_brand_name: '', p_trace_id: uuidv7() }),
      );
      expect(req.error).toBeNull();
      const res = await invite(w.id, du.user.email, 'client');
      expect(res.error).toBeNull();
      const row = await admin
        .from('brand_agency_requests')
        .select('fulfilled_at')
        .eq('id', String(req.data))
        .single();
      expect((row.data as { fulfilled_at: string | null }).fulfilled_at).not.toBeNull();
    });

    it('cannot be written directly by authenticated users', async () => {
      const du = await seedUserAt('brand-direct.test');
      const res = await asGeneric(du.client)
        .from('brand_agency_requests')
        .insert({ requested_by: du.user.id, agency_email: 'x@agency.test' });
      expect(res.error).not.toBeNull();
    });
  });

  describe('induction_step_set', () => {
    it('refuses a step that is not ^[a-z0-9_]{1,40}$ (invalid_payload)', async () => {
      for (const step of ['Bad-Step', '', 'x'.repeat(41)]) {
        const res = await clientFor(owner.id).rpc(
          'induction_step_set',
          rpcArgs({ p_step: step, p_trace_id: uuidv7() }),
        );
        expect(res.error?.message).toBe('invalid_payload');
      }
    });

    it('saves a well-formed step', async () => {
      const res = await clientFor(owner.id).rpc(
        'induction_step_set',
        rpcArgs({ p_step: 'invite_client_2', p_trace_id: uuidv7() }),
      );
      expect(res.error).toBeNull();
      const row = await admin
        .from('user_private')
        .select('induction_step')
        .eq('user_id', owner.id)
        .single();
      expect((row.data as { induction_step: string }).induction_step).toBe('invite_client_2');
    });
  });

  describe('welcome inbox rows', () => {
    it('workspace_create writes one system row for the creator and names the group by platform', async () => {
      const creator = await seedUser(env, admin);
      users.push(creator);
      const res = await clientFor(creator.id).rpc(
        'workspace_create',
        rpcArgs({
          p_payload: { name: 'Kite & Co', timezone: 'UTC', platform: 'linkedin' },
          p_trace_id: uuidv7(),
        }),
      );
      expect(res.error).toBeNull();
      const wsId = String(res.data);
      workspaces.push({ id: wsId, name: 'Kite & Co', ownerId: creator.id });
      const rows = await g
        .from('inbox_entries')
        .select('user_id, event_type, entity_type, entity_id, tier, payload')
        .eq('workspace_id', wsId);
      expect(rows.data).toEqual([
        {
          user_id: creator.id,
          event_type: 'system',
          entity_type: 'workspace',
          entity_id: wsId,
          tier: 'ambient',
          payload: { kind: 'welcome', workspace_name: 'Kite & Co', platform: 'linkedin' },
        },
      ]);
      const group = await admin
        .from('groups')
        .select('name')
        .eq('workspace_id', wsId)
        .eq('is_default', true)
        .single();
      expect((group.data as { name: string }).name).toBe('Kite and Co - LinkedIn');
    });

    it('member_accept writes one system row for the invitee', async () => {
      const w = await newWorkspace();
      const invitee = await seedUser(env, admin);
      users.push(invitee);
      const inv = await invite(w.id, invitee.email, 'agency');
      expect(inv.error).toBeNull();
      const acc = await clientFor(invitee.id).rpc(
        'member_accept',
        rpcArgs({ p_invite_id: String(inv.data), p_trace_id: uuidv7() }),
      );
      expect(acc.error).toBeNull();
      const rows = await g
        .from('inbox_entries')
        .select('user_id, event_type')
        .eq('workspace_id', w.id)
        .eq('event_type', 'system');
      expect(rows.data).toEqual([{ user_id: invitee.id, event_type: 'system' }]);
    });
  });
});
