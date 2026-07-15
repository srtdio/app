// Helpers for the inbox-writer suite. Builds on the RLS suite's local-container
// seeding (packages/test-utils/rls.ts): the same ephemeral Supabase stack, the
// same service-role seeding path. Adds an in-memory KV double and a ProcessDeps
// factory so processEvent runs end to end against the real database.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  asGeneric,
  insertRow,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
} from '../../packages/test-utils/rls';
import type { DedupeKv, ProcessDeps } from '../../workers/inbox-writer/src/process';
import { uuidv7 } from '../../workers/inbox-writer/src/uuid';

// The well-known local-dev JWT secret baked into `supabase start`. Local infra
// only; never a real secret. Used to mint the acting-member service_role token.
export const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

/** In-memory stand-in for the inbox_writer_dedupe KV namespace. */
export function inMemoryKv(): DedupeKv & { size(): number } {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    size() {
      return store.size;
    },
  };
}

export interface InboxWorkspace {
  workspaceId: string;
  bucketId: string;
  owner: SeededUser;
  admin: SeededUser;
  agency: SeededUser;
  client: SeededUser;
  users: SeededUser[];
}

async function addMember(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  user: SeededUser,
  role: string,
  active = true,
): Promise<string> {
  const row = await insertRow(asGeneric(admin), 'workspace_members', {
    workspace_id: workspaceId,
    user_id: user.id,
    role,
    active,
    accepted_at: active ? new Date().toISOString() : null,
  });
  return String(row.id);
}

/** Seed a workspace with one active member at each role plus a bucket. */
export async function seedInboxWorkspace(
  env: RlsEnv,
  admin: SupabaseClient<Database>,
): Promise<InboxWorkspace> {
  const owner = await seedUser(env, admin);
  const ws = await seedWorkspace(admin, owner, `Inbox ${owner.email}`);
  const adminU = await seedUser(env, admin);
  await addMember(admin, ws.id, adminU, 'admin');
  const agency = await seedUser(env, admin);
  await addMember(admin, ws.id, agency, 'agency');
  const client = await seedUser(env, admin);
  await addMember(admin, ws.id, client, 'client');

  const bucket = await insertRow(asGeneric(admin), 'workspace_buckets', {
    workspace_id: ws.id,
    name: 'Bucket',
    color_hex: '#112233',
  });

  return {
    workspaceId: ws.id,
    bucketId: String(bucket.id),
    owner,
    admin: adminU,
    agency,
    client,
    users: [owner, adminU, agency, client],
  };
}

/** Insert a row through the service role and return the full row, typed. */
export async function insertFull<T>(
  admin: SupabaseClient<Database>,
  table: string,
  values: Record<string, unknown>,
): Promise<T> {
  return (await insertRow(asGeneric(admin), table, values)) as T;
}

/** ProcessDeps wired to the local stack: real reads/audit, in-memory KV. */
export function makeDeps(
  env: RlsEnv,
  admin: SupabaseClient<Database>,
  kv: DedupeKv,
  log: (line: Record<string, unknown>) => void = () => {},
): ProcessDeps {
  return {
    readerClient: admin,
    url: env.url,
    serviceKey: env.serviceKey,
    jwtSecret: LOCAL_JWT_SECRET,
    kv,
    newTraceId: uuidv7,
    log,
  };
}

export interface InboxEntryRow {
  user_id: string;
  tier: string;
  entity_type: string | null;
  entity_id: string | null;
  event_type: string;
  payload: unknown;
}

/** All inbox entries for a workspace at a given event_type (fresh-per-test ws). */
export async function entriesFor(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  eventType: string,
): Promise<InboxEntryRow[]> {
  const res = await admin
    .from('inbox_entries')
    .select('user_id, tier, entity_type, entity_id, event_type, payload')
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType);
  if (res.error) throw new Error(`read inbox_entries failed: ${res.error.message}`);
  return (res.data ?? []) as InboxEntryRow[];
}

/** The recipient user-id set for a workspace/event_type. */
export async function recipientsFor(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  eventType: string,
): Promise<Set<string>> {
  const rows = await entriesFor(admin, workspaceId, eventType);
  return new Set(rows.map((r) => r.user_id));
}
