// RLS test helpers. Plain TypeScript, no test framework imports, so this module
// is reusable from any runner. Every Postgrest call here runs against a local,
// ephemeral Supabase container (see tests/rls/setup.ts); nothing connects to the
// live database.
//
// Design notes that the test files rely on:
//   * The authenticated role has NO write policies on tenant tables (default
//     deny), and the snapshot's workspace_members SELECT policy is
//     self-referential, so authenticated reads of membership-gated tables raise
//     "infinite recursion". Both are faithful to live. We therefore SEED through
//     the service role (the privileged path the app reaches via SECURITY DEFINER
//     server functions) and prove isolation against service-role ground truth:
//     attacker reads return no victim rows, and attacker writes affect 0 rows.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../schemas/src/supabase.generated';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface RlsEnv {
  url: string;
  anonKey: string;
  serviceKey: string;
  dbUrl: string;
}

/** Path of the JSON handoff written by the global setup process. */
export const rlsEnvFile = join(tmpdir(), 'sorted-rls-env.json');

/** Read the connection env produced by tests/rls/setup.ts. */
export function loadRlsEnv(): RlsEnv {
  const raw = JSON.parse(readFileSync(rlsEnvFile, 'utf8')) as Partial<RlsEnv>;
  const { url, anonKey, serviceKey, dbUrl } = raw;
  if (!url || !anonKey || !serviceKey || !dbUrl) {
    throw new Error('rls env handoff is incomplete; was tests/rls/setup.ts run?');
  }
  return { url, anonKey, serviceKey, dbUrl };
}

const noPersist = { auth: { autoRefreshToken: false, persistSession: false } } as const;

/** Service-role client. Bypasses RLS; used for seeding and ground-truth reads. */
export function createAdminClient(env: RlsEnv): SupabaseClient<Database> {
  return createClient<Database>(env.url, env.serviceKey, noPersist);
}

/** Unauthenticated (anon role) client. */
export function createAnonClient(env: RlsEnv): SupabaseClient<Database> {
  return createClient<Database>(env.url, env.anonKey, noPersist);
}

// ---------------------------------------------------------------------------
// Generic, table-agnostic Postgrest surface
// ---------------------------------------------------------------------------
//
// Postgrest's generated types cannot express dynamic table / column access, so
// the parameterized runner talks to this hand-written structural interface. The
// single `as unknown as GenericClient` cast below is the only type assertion in
// the suite: it narrows the real client to the subset of methods we use, all of
// which exist at runtime. No `any`, no `@ts-ignore`.

export interface GenericResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

export interface GenericFilter extends PromiseLike<GenericResult> {
  eq(column: string, value: string | number | boolean): GenericFilter;
  select(columns?: string): GenericFilter;
}

export interface GenericTable {
  select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): GenericFilter;
  insert(values: Record<string, unknown>, opts?: { count?: 'exact' }): GenericFilter;
  update(values: Record<string, unknown>, opts?: { count?: 'exact' }): GenericFilter;
  delete(opts?: { count?: 'exact' }): GenericFilter;
}

export interface GenericClient {
  from(table: string): GenericTable;
}

export function asGeneric(client: SupabaseClient<Database>): GenericClient {
  return client as unknown as GenericClient;
}

/** A column/value identity used to locate the seeded victim row. */
export type MatchSpec = ReadonlyArray<readonly [string, string | number | boolean]>;

function applyMatch(filter: GenericFilter, match: MatchSpec): GenericFilter {
  let f = filter;
  for (const [column, value] of match) f = f.eq(column, value);
  return f;
}

/** Insert one row through the service role and return it. Throws on error. */
export async function insertRow(
  admin: GenericClient,
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await admin.from(table).insert(values).select('*');
  if (res.error) throw new Error(`${table} insert failed: ${res.error.message}`);
  const rows = res.data as Record<string, unknown>[] | null;
  const first = rows?.[0];
  if (!first) throw new Error(`${table} insert returned no row`);
  return first;
}

/** Count rows matching `match` via the service role (RLS-bypassing ground truth). */
export async function countWhere(
  admin: GenericClient,
  table: string,
  match: MatchSpec,
): Promise<number> {
  const res = await applyMatch(
    admin.from(table).select('*', { count: 'exact', head: true }),
    match,
  );
  if (res.error) throw new Error(`${table} count failed: ${res.error.message}`);
  return res.count ?? 0;
}

/** Number of matching rows the given client can actually read (0 if RLS blocks). */
export async function visibleRowCount(
  client: GenericClient,
  table: string,
  match: MatchSpec,
): Promise<number> {
  const res = await applyMatch(client.from(table).select('*'), match);
  if (res.error) return 0; // recursion / default-deny both mean "no rows obtained"
  return Array.isArray(res.data) ? res.data.length : 0;
}

/** Rows affected by an attacker UPDATE (no returning clause, to avoid the read path). */
export async function updateRowCount(
  client: GenericClient,
  table: string,
  match: MatchSpec,
  patch: Record<string, unknown>,
): Promise<number> {
  const res = await applyMatch(client.from(table).update(patch, { count: 'exact' }), match);
  return res.count ?? 0;
}

/** Rows affected by an attacker DELETE. */
export async function deleteRowCount(
  client: GenericClient,
  table: string,
  match: MatchSpec,
): Promise<number> {
  const res = await applyMatch(client.from(table).delete({ count: 'exact' }), match);
  return res.count ?? 0;
}

/**
 * Same-tenant positive-read control. Unlike {@link visibleRowCount} this does
 * NOT swallow errors: a failing read (e.g. a self-referential / recursive SELECT
 * policy) THROWS with the table name and underlying message, so a 0 elsewhere is
 * proven to be a real RLS deny rather than a query error. Never coerces to 0.
 */
export async function ownReadCount(
  client: GenericClient,
  table: string,
  match: MatchSpec,
): Promise<number> {
  const res = await applyMatch(
    client.from(table).select('*', { count: 'exact', head: true }),
    match,
  );
  if (res.error) {
    throw new Error(`${table}: own-read failed (read path broken): ${res.error.message}`);
  }
  return res.count ?? 0;
}

/** Outcome of an authenticated INSERT attempt (no returning clause). */
export interface InsertOutcome {
  /** True when Postgrest reported no error. */
  ok: boolean;
  /** Rows the server reports as inserted (0 when RLS WITH CHECK denies). */
  count: number;
  /** Error message when the insert was rejected, else null. */
  error: string | null;
}

/** Attempt an INSERT as the given client and report the outcome without reading back. */
export async function authInsert(
  client: GenericClient,
  table: string,
  values: Record<string, unknown>,
): Promise<InsertOutcome> {
  const res = await client.from(table).insert(values, { count: 'exact' });
  return { ok: res.error === null, count: res.count ?? 0, error: res.error?.message ?? null };
}

/**
 * Runtime discovery: tenant tables that BOTH grant INSERT to the `authenticated`
 * role AND carry a row-security policy with a WITH CHECK expression. Catalog
 * queries only (information_schema.role_table_grants + pg_policies.with_check),
 * snake_case SQL, read via psql against the local container.
 */
export function discoverAuthenticatedInsertTables(dbUrl: string): string[] {
  const sql =
    'select g.table_name ' +
    'from information_schema.role_table_grants g ' +
    "where g.grantee = 'authenticated' and g.privilege_type = 'INSERT' " +
    "and g.table_schema = 'public' " +
    'and exists (select 1 from pg_policies p ' +
    "where p.schemaname = 'public' and p.tablename = g.table_name " +
    "and p.cmd in ('INSERT', 'ALL') and p.with_check is not null) " +
    'order by g.table_name;';
  const out = execFileSync('psql', [dbUrl, '-At', '-c', sql], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Deterministic value generators (no hardcoded ids / names)
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * A random workspace key satisfying the workspaces_key_format check
 * (^[A-Z][A-Z0-9]{1,4}$): a leading 'T' plus four crypto-random base36 chars, so
 * it is unique across parallel test runs without a shared counter. Retries at the
 * insert site are unnecessary at this cardinality (36^4 ≈ 1.7M).
 */
export function randomWorkspaceKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let suffix = '';
  for (const b of bytes) suffix += alphabet[b % 36];
  return `T${suffix}`;
}

/**
 * Allocate the next per-workspace entity number the way post_create/brief_create
 * do in production: read the workspace_counters row (seeded by the
 * workspaces_seed_counter trigger), return its current value, and advance it by
 * one. Service-role access bypasses RLS; the counter is never hardcoded.
 */
export async function nextEntityNumber(g: GenericClient, workspaceId: string): Promise<number> {
  const read = await g
    .from('workspace_counters')
    .select('next_entity_number')
    .eq('workspace_id', workspaceId);
  if (read.error) throw new Error(`workspace_counters read failed: ${read.error.message}`);
  const rows = read.data as { next_entity_number: number }[] | null;
  const current = rows?.[0]?.next_entity_number;
  if (typeof current !== 'number') {
    throw new Error(`workspace_counters row missing for ${workspaceId}`);
  }
  const upd = await g
    .from('workspace_counters')
    .update({ next_entity_number: current + 1 })
    .eq('workspace_id', workspaceId);
  if (upd.error) throw new Error(`workspace_counters update failed: ${upd.error.message}`);
  return current;
}

export function randomSha256(): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  return out;
}

// A timestamp that always lands inside a partition shipped by the baseline
// migration (chat_messages / inbox_entries / audit_log cover mid-2026), so the
// suite is independent of the wall clock.
export const partitionTimestamp = '2026-06-15T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Users and workspaces
// ---------------------------------------------------------------------------

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

export interface SeededWorkspace {
  id: string;
  name: string;
  ownerId: string;
}

const clientRegistry = new Map<string, SupabaseClient<Database>>();

/**
 * Create an auth user (the signup trigger mirrors it into public.users), sign
 * it in, and register its authenticated client for {@link clientFor}.
 */
export async function seedUser(env: RlsEnv, admin: SupabaseClient<Database>): Promise<SeededUser> {
  const email = `rls_${randomSuffix()}@example.test`;
  const password = `Pw_${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`createUser failed: ${created.error?.message ?? 'no user'}`);
  }
  const userClient = createClient<Database>(env.url, env.anonKey, noPersist);
  const signIn = await userClient.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`signIn failed: ${signIn.error.message}`);
  const id = created.data.user.id;
  clientRegistry.set(id, userClient);
  return { id, email, password };
}

/** The authenticated client for a previously {@link seedUser}'d user id. */
export function clientFor(userId: string): SupabaseClient<Database> {
  const client = clientRegistry.get(userId);
  if (!client) throw new Error(`no client registered for user ${userId}`);
  return client;
}

/** Insert a workspace owned by `owner` and add `owner` as the active owner member. */
export async function seedWorkspace(
  admin: SupabaseClient<Database>,
  owner: SeededUser,
  name: string,
): Promise<SeededWorkspace> {
  const generic = asGeneric(admin);
  const ws = await insertRow(generic, 'workspaces', {
    name,
    owner_user_id: owner.id,
    timezone: 'UTC',
    key: randomWorkspaceKey(),
  });
  const id = String(ws.id);
  await insertRow(generic, 'workspace_members', {
    workspace_id: id,
    user_id: owner.id,
    role: 'owner',
    active: true,
  });
  return { id, name, ownerId: owner.id };
}

/** Grant a seeded user active platform-operator status (service-role insert). */
export async function seedOperator(admin: GenericClient, user: SeededUser): Promise<void> {
  await insertRow(admin, 'platform_operators', { user_id: user.id });
}

// ---------------------------------------------------------------------------
// Per-workspace scaffold of parent rows that the leaf tables reference
// ---------------------------------------------------------------------------

export interface Ctx {
  workspaceId: string;
  userId: string;
  bucketId: string;
  briefId: string;
  postId: string;
  postVersionId: string;
  assetId: string;
  assetVersionId: string;
  commentId: string;
  groupId: string;
  channelId: string;
  webhookEventId: string;
}

/** Seed the shared parent entities for a workspace and return their ids. */
export async function seedScaffold(
  admin: SupabaseClient<Database>,
  ws: SeededWorkspace,
): Promise<Ctx> {
  const g = asGeneric(admin);
  const workspaceId = ws.id;
  const userId = ws.ownerId;

  const bucket = await insertRow(g, 'workspace_buckets', {
    workspace_id: workspaceId,
    name: `Bucket ${randomSuffix()}`,
    color_hex: '#112233',
  });
  const brief = await insertRow(g, 'briefs', {
    workspace_id: workspaceId,
    number: await nextEntityNumber(g, workspaceId),
    title: 'Brief',
    objective: 'Objective',
    created_by: userId,
  });
  const post = await insertRow(g, 'posts', {
    workspace_id: workspaceId,
    number: await nextEntityNumber(g, workspaceId),
    title: 'Post',
    bucket_id: bucket.id,
    owner_user_id: userId,
    platform: 'linkedin',
    format: 'text',
    created_by: userId,
  });
  const postVersion = await insertRow(g, 'post_versions', {
    post_id: post.id,
    workspace_id: workspaceId,
    version_number: 1,
    snapshot: {},
    created_by: userId,
  });
  const asset = await insertRow(g, 'assets', {
    workspace_id: workspaceId,
    filename: 'file.png',
    uploaded_by: userId,
  });
  const assetVersion = await insertRow(g, 'asset_versions', {
    asset_id: asset.id,
    workspace_id: workspaceId,
    version_number: 1,
    kind: 'image',
    r2_key: `key/${crypto.randomUUID()}`,
    mime_type: 'image/png',
    sha256: randomSha256(),
    size_bytes: 1,
    uploaded_by: userId,
  });
  const comment = await insertRow(g, 'comments', {
    workspace_id: workspaceId,
    entity_type: 'post',
    entity_id: post.id,
    author_user_id: userId,
    body: 'comment',
  });
  const group = await insertRow(g, 'groups', {
    workspace_id: workspaceId,
    name: `Grp ${randomSuffix()}`,
    created_by: userId,
  });
  const channelId = `group__${String(group.id)}__c`;
  await insertRow(g, 'chat_channels', {
    channel_id: channelId,
    workspace_id: workspaceId,
    channel_type: 'group',
    entity_id: group.id,
  });
  const webhookEvent = await insertRow(g, 'webhook_events', {
    workspace_id: workspaceId,
    source: 'stripe',
    source_event_id: crypto.randomUUID(),
    event_type: 'test',
    signature_verified: true,
    raw_payload: {},
  });

  return {
    workspaceId,
    userId,
    bucketId: String(bucket.id),
    briefId: String(brief.id),
    postId: String(post.id),
    postVersionId: String(postVersion.id),
    assetId: String(asset.id),
    assetVersionId: String(assetVersion.id),
    commentId: String(comment.id),
    groupId: String(group.id),
    channelId,
    webhookEventId: String(webhookEvent.id),
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped table probes
// ---------------------------------------------------------------------------

export interface SeededTarget {
  /** Identity of the seeded workspace-A row(s). */
  match: MatchSpec;
  /** A valid mutation an attacker would attempt; empty when no column is safe. */
  patch: Record<string, unknown>;
}

export interface TenantTableProbe {
  table: string;
  /** Seed the workspace-scoped row(s) via the service role and return their identity. */
  seed(admin: GenericClient, ctx: Ctx): Promise<SeededTarget> | SeededTarget;
  /**
   * Principal that legitimately reads the seeded row for the positive-read
   * control. 'member' (default) is the workspace owner; 'operator' is a platform
   * operator, for tables whose only SELECT policy is operator-scoped and which
   * therefore have no membership read path by design.
   */
  positiveReader?: 'member' | 'operator';
}

/**
 * Every tenant-scoped table named in the task, with a seeder that either reuses
 * a scaffold parent row or inserts a leaf row. `ctx` belongs to workspace A.
 */
export const tenantTables: readonly TenantTableProbe[] = [
  {
    table: 'workspaces',
    seed: (_a, c) => ({ match: [['id', c.workspaceId]], patch: { name: `zz ${randomSuffix()}` } }),
  },
  {
    table: 'workspace_members',
    seed: (_a, c) => ({
      match: [
        ['workspace_id', c.workspaceId],
        ['user_id', c.userId],
      ],
      patch: { role: 'admin' },
    }),
  },
  {
    table: 'workspace_role_permissions',
    seed: (_a, c) => ({
      match: [
        ['workspace_id', c.workspaceId],
        ['role', 'owner'],
        ['capability', 'post.create'],
      ],
      patch: { allowed: false },
    }),
  },
  {
    table: 'workspace_settings',
    seed: async (a, c) => {
      await insertRow(a, 'workspace_settings', { workspace_id: c.workspaceId });
      return { match: [['workspace_id', c.workspaceId]], patch: { payload: { x: 1 } } };
    },
  },
  {
    table: 'workspace_onboarding',
    seed: (_a, c) => ({
      match: [['workspace_id', c.workspaceId]],
      patch: { dismissed_at: partitionTimestamp },
    }),
  },
  {
    table: 'workspace_buckets',
    seed: (_a, c) => ({ match: [['id', c.bucketId]], patch: { name: `zz ${randomSuffix()}` } }),
  },
  {
    table: 'posts',
    seed: (_a, c) => ({ match: [['id', c.postId]], patch: { title: 'zz' } }),
  },
  {
    table: 'post_versions',
    seed: (_a, c) => ({ match: [['id', c.postVersionId]], patch: { snapshot: { y: 1 } } }),
  },
  {
    table: 'post_annotations',
    seed: async (a, c) => {
      const row = await insertRow(a, 'post_annotations', {
        post_id: c.postId,
        workspace_id: c.workspaceId,
        post_version_id: c.postVersionId,
        kind: 'caption_span',
        caption_start: 0,
        caption_end: 5,
        comment_id: c.commentId,
      });
      return { match: [['id', String(row.id)]], patch: { caption_end: 6 } };
    },
  },
  {
    table: 'comments',
    seed: (_a, c) => ({ match: [['id', c.commentId]], patch: { body: 'zz' } }),
  },
  {
    table: 'comment_reactions',
    seed: async (a, c) => {
      await insertRow(a, 'comment_reactions', {
        comment_id: c.commentId,
        user_id: c.userId,
        emoji: 'x',
        workspace_id: c.workspaceId,
      });
      return {
        match: [
          ['comment_id', c.commentId],
          ['user_id', c.userId],
          ['emoji', 'x'],
        ],
        patch: {},
      };
    },
  },
  {
    table: 'briefs',
    seed: (_a, c) => ({ match: [['id', c.briefId]], patch: { title: 'zz' } }),
  },
  {
    table: 'assets',
    seed: (_a, c) => ({ match: [['id', c.assetId]], patch: { filename: 'zz.png' } }),
  },
  {
    table: 'asset_versions',
    seed: (_a, c) => ({ match: [['id', c.assetVersionId]], patch: { mime_type: 'image/jpeg' } }),
  },
  {
    table: 'asset_attachments',
    seed: async (a, c) => {
      const row = await insertRow(a, 'asset_attachments', {
        asset_id: c.assetId,
        asset_version_id: c.assetVersionId,
        entity_type: 'post',
        entity_id: c.postId,
        workspace_id: c.workspaceId,
        attached_by: c.userId,
      });
      return { match: [['id', String(row.id)]], patch: { position: 2 } };
    },
  },
  {
    table: 'folders',
    seed: async (a, c) => {
      const row = await insertRow(a, 'folders', {
        workspace_id: c.workspaceId,
        name: `Folder ${randomSuffix()}`,
        created_by: c.userId,
      });
      return { match: [['id', String(row.id)]], patch: { name: `zz ${randomSuffix()}` } };
    },
  },
  {
    table: 'groups',
    seed: (_a, c) => ({ match: [['id', c.groupId]], patch: { name: `Zz ${randomSuffix()}` } }),
  },
  {
    table: 'group_members',
    seed: async (a, c) => {
      await insertRow(a, 'group_members', {
        group_id: c.groupId,
        user_id: c.userId,
        workspace_id: c.workspaceId,
      });
      return {
        match: [
          ['group_id', c.groupId],
          ['user_id', c.userId],
        ],
        patch: {},
      };
    },
  },
  {
    table: 'chat_channels',
    seed: (_a, c) => ({
      match: [['channel_id', c.channelId]],
      patch: { last_synced_at: partitionTimestamp },
    }),
  },
  {
    table: 'chat_messages',
    seed: async (a, c) => {
      const row = await insertRow(a, 'chat_messages', {
        id: crypto.randomUUID(),
        channel_id: c.channelId,
        workspace_id: c.workspaceId,
        agora_event_id: crypto.randomUUID(),
        created_at: partitionTimestamp,
      });
      return { match: [['id', String(row.id)]], patch: { body: 'zz' } };
    },
  },
  {
    table: 'inbox_entries',
    seed: async (a, c) => {
      const row = await insertRow(a, 'inbox_entries', {
        user_id: c.userId,
        workspace_id: c.workspaceId,
        event_type: 'system',
        scope: 'everything',
        created_at: partitionTimestamp,
      });
      return { match: [['id', String(row.id)]], patch: { tier: 'urgent' } };
    },
  },
  {
    table: 'email_threads',
    seed: async (a, c) => {
      const row = await insertRow(a, 'email_threads', {
        workspace_id: c.workspaceId,
        root_type: 'post',
        root_id: c.postId,
        message_id: `<post-${c.postId}@srtd.io>`,
        subject: 'subject',
      });
      return { match: [['id', String(row.id)]], patch: { subject: 'subject 2' } };
    },
  },
  {
    table: 'delivery_attempts',
    seed: async (a, c) => {
      const row = await insertRow(a, 'delivery_attempts', {
        workspace_id: c.workspaceId,
        channel: 'email',
        template_key: 'k',
        provider: 'resend',
      });
      return { match: [['id', String(row.id)]], patch: { status: 'sent' } };
    },
  },
  {
    table: 'audit_log',
    seed: async (a, c) => {
      const row = await insertRow(a, 'audit_log', {
        workspace_id: c.workspaceId,
        action: 'test',
        outcome: 'success',
        trace_id: generateTraceId(),
        created_at: partitionTimestamp,
      });
      return { match: [['id', String(row.id)]], patch: { action: 'mutated' } };
    },
  },
  {
    table: 'feature_flags',
    seed: async (a, c) => {
      const row = await insertRow(a, 'feature_flags', {
        workspace_id: c.workspaceId,
        flag_name: `f${randomSuffix()}`,
        category: 'experiment',
      });
      return { match: [['id', String(row.id)]], patch: { enabled: true } };
    },
  },
  {
    table: 'intent_ledger',
    positiveReader: 'operator',
    seed: async (a, c) => {
      const row = await insertRow(a, 'intent_ledger', {
        operator_user_id: c.userId,
        action: 'act',
        payload: {},
        trace_id: generateTraceId(),
      });
      return { match: [['id', String(row.id)]], patch: { status: 'failed' } };
    },
  },
  {
    table: 'pending_flows',
    positiveReader: 'operator',
    seed: async (a, c) => {
      const row = await insertRow(a, 'pending_flows', {
        operator_user_id: c.userId,
        flow_type: 'cf_purge',
        external_system: 'cloudflare',
        payload: {},
      });
      return { match: [['id', String(row.id)]], patch: { status: 'discarded' } };
    },
  },
  {
    table: 'webhook_events',
    positiveReader: 'operator',
    seed: (_a, c) => ({ match: [['id', c.webhookEventId]], patch: { event_type: 'mutated' } }),
  },
  {
    table: 'webhook_processing_attempts',
    positiveReader: 'operator',
    seed: async (a, c) => {
      const row = await insertRow(a, 'webhook_processing_attempts', {
        webhook_event_id: c.webhookEventId,
        attempt_number: 1,
        trace_id: generateTraceId(),
      });
      return { match: [['id', String(row.id)]], patch: { outcome: 'success' } };
    },
  },
  {
    table: 'cockpit_access_log',
    positiveReader: 'operator',
    seed: async (a, c) => {
      const row = await insertRow(a, 'cockpit_access_log', {
        operator_user_id: c.userId,
        route: '/x',
        session_id: crypto.randomUUID(),
        trace_id: generateTraceId(),
        workspace_id: c.workspaceId,
      });
      return { match: [['id', String(row.id)]], patch: { route: '/y' } };
    },
  },
  {
    table: 'session_devices',
    seed: async (a, c) => {
      const row = await insertRow(a, 'session_devices', {
        user_id: c.userId,
        fingerprint_hash: randomSha256(),
      });
      return { match: [['id', String(row.id)]], patch: { user_agent: 'z' } };
    },
  },
];

// ---------------------------------------------------------------------------
// Teardown helpers
// ---------------------------------------------------------------------------

/** Remove seeded workspaces (cascades) and auth users; clears the client registry. */
export async function cleanupWorkspaces(
  admin: SupabaseClient<Database>,
  workspaces: readonly SeededWorkspace[],
  users: readonly SeededUser[],
): Promise<void> {
  const g = asGeneric(admin);
  for (const ws of workspaces) {
    await g.from('workspaces').delete().eq('id', ws.id);
  }
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id);
    clientRegistry.delete(user.id);
  }
}
