// Unread comment markers (inbox_unread_entity_counts, inbox_mark_entity_read),
// exercised end to end against the local stack as the authenticated role. The
// read counts only the caller's unread comment + mention rows per post and per
// plan item; the write marks only the caller's rows for one entity, rejects
// other entity types and non-members, and leaves other entities, other users,
// other event types and live snoozes alone. Anon can execute neither. Ground
// truth is read back through the service role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  partitionTimestamp,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';

const INBOX_SUITE = process.env.INBOX_SUITE === '1';
const SNOOZED_FUTURE = '2099-01-01T00:00:00.000Z';
type CountsArgs = Database['public']['Functions']['inbox_unread_entity_counts']['Args'];
type MarkArgs = Database['public']['Functions']['inbox_mark_entity_read']['Args'];

describe.runIf(INBOX_SUITE)('inbox unread entity procs', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let member: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  const postA = crypto.randomUUID();
  const postB = crypto.randomUUID();
  const itemA = crypto.randomUUID();

  async function insertEntry(userId: string, over: Record<string, unknown>): Promise<string> {
    const row = await insertRow(asGeneric(admin), 'inbox_entries', {
      user_id: userId,
      workspace_id: ws.id,
      event_type: 'comment',
      entity_type: 'post',
      entity_id: postA,
      scope: 'posts',
      tier: 'active',
      created_at: partitionTimestamp,
      ...over,
    });
    return String(row.id);
  }

  async function readAt(id: string): Promise<string | null> {
    const res = await admin.from('inbox_entries').select('read_at').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`read entry failed: ${res.error.message}`);
    return (res.data as { read_at: string | null } | null)?.read_at ?? null;
  }

  async function counts(userId: string): Promise<Record<string, number>> {
    const args: CountsArgs = { p_trace_id: generateTraceId(), p_workspace_id: ws.id };
    const res = await clientFor(userId).rpc('inbox_unread_entity_counts', args);
    if (res.error) throw new Error(`counts failed: ${res.error.message}`);
    const out: Record<string, number> = {};
    for (const row of res.data ?? []) out[`${row.entity_type}:${row.entity_id}`] = row.unread;
    return out;
  }

  async function markRead(
    userId: string,
    entityType: string,
    entityId: string,
  ): Promise<{ error: { message: string } | null }> {
    const args: MarkArgs = {
      p_workspace_id: ws.id,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_trace_id: generateTraceId(),
    };
    return clientFor(userId).rpc('inbox_mark_entity_read', args);
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    owner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Unread ${owner.email}`);
    member = await seedUser(env, admin);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: ws.id,
      user_id: member.id,
      role: 'agency',
      active: true,
      accepted_at: new Date().toISOString(),
    });
    outsider = await seedUser(env, admin);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, member, outsider]);
  });

  it('counts only the caller own unread comment and mention rows, per entity', async () => {
    await insertEntry(member.id, {});
    await insertEntry(member.id, { event_type: 'mention' });
    await insertEntry(member.id, { event_type: 'stage_change' });
    await insertEntry(member.id, { event_type: 'comment_resolved' });
    await insertEntry(member.id, { read_at: new Date().toISOString() });
    await insertEntry(member.id, { snoozed_until: SNOOZED_FUTURE });
    await insertEntry(member.id, {
      event_type: 'plan_comment',
      entity_type: 'plan_item',
      entity_id: itemA,
    });
    await insertEntry(owner.id, { entity_id: postB });

    const mine = await counts(member.id);
    expect(mine[`post:${postA}`]).toBe(2);
    expect(mine[`plan_item:${itemA}`]).toBe(1);
    expect(mine[`post:${postB}`]).toBeUndefined();
  });

  it('a non-member reads nothing', async () => {
    expect(await counts(outsider.id)).toEqual({});
  });

  it('mark read clears the caller rows for that entity only', async () => {
    const mineA = await insertEntry(member.id, {});
    const mineB = await insertEntry(member.id, { entity_id: postB });
    const theirsA = await insertEntry(owner.id, {});
    const stageA = await insertEntry(member.id, { event_type: 'stage_change' });
    const snoozedA = await insertEntry(member.id, { snoozed_until: SNOOZED_FUTURE });

    const res = await markRead(member.id, 'post', postA);
    expect(res.error).toBeNull();
    expect(await readAt(mineA)).not.toBeNull();
    expect(await readAt(mineB)).toBeNull();
    expect(await readAt(theirsA)).toBeNull();
    expect(await readAt(stageA)).toBeNull();
    expect(await readAt(snoozedA)).toBeNull();
    expect((await counts(member.id))[`post:${postA}`]).toBeUndefined();
  });

  it('mark read rejects other entity types, a blank id and non-members', async () => {
    expect((await markRead(member.id, 'brief', postA)).error?.message).toContain('invalid_payload');
    expect((await markRead(member.id, 'post', '')).error?.message).toContain('invalid_payload');
    expect((await markRead(outsider.id, 'post', postA)).error?.message).toContain(
      'workspace_member_only',
    );
  });

  it('anon can execute neither proc', async () => {
    const anon = createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const readArgs: CountsArgs = { p_trace_id: generateTraceId(), p_workspace_id: ws.id };
    const read = await anon.rpc('inbox_unread_entity_counts', readArgs);
    expect(read.error).not.toBeNull();
    const writeArgs: MarkArgs = {
      p_workspace_id: ws.id,
      p_entity_type: 'post',
      p_entity_id: postA,
      p_trace_id: generateTraceId(),
    };
    const write = await anon.rpc('inbox_mark_entity_read', writeArgs);
    expect(write.error).not.toBeNull();
  });
});
