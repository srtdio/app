// Per-user read-state + snooze procs, exercised end to end against the local
// stack as the authenticated role (the path the Activity surface uses). Each
// proc is gated on is_active_workspace_member and scoped to auth.uid(), so the
// suite proves: a member clears only their OWN rows, a non-member is rejected,
// mark-all skips snoozed rows, and snooze validates its kind. Ground truth is
// read back through the service role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
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
import { inboxMarkAllRead, inboxMarkRead, inboxSnooze } from '../../packages/rpc/src/index';

const INBOX_SUITE = process.env.INBOX_SUITE === '1';

describe.runIf(INBOX_SUITE)('inbox read-state procs', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let member: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;

  async function insertEntry(userId: string, over: Record<string, unknown> = {}): Promise<string> {
    const generic = asGeneric(admin);
    const row = await insertRow(generic, 'inbox_entries', {
      user_id: userId,
      workspace_id: ws.id,
      event_type: 'comment',
      scope: 'posts',
      tier: 'active',
      created_at: partitionTimestamp,
      ...over,
    });
    return String(row.id);
  }

  async function readEntry(
    id: string,
  ): Promise<{ readAt: string | null; snoozedUntil: string | null }> {
    const res = await admin
      .from('inbox_entries')
      .select('read_at, snoozed_until')
      .eq('id', id)
      .maybeSingle();
    if (res.error) throw new Error(`read entry failed: ${res.error.message}`);
    const data = res.data as { read_at: string | null; snoozed_until: string | null } | null;
    return { readAt: data?.read_at ?? null, snoozedUntil: data?.snoozed_until ?? null };
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
    owner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Activity ${owner.email}`);
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

  it('inbox_mark_read clears read_at on the caller own unread row', async () => {
    const id = await insertEntry(member.id);
    const before = await readEntry(id);
    expect(before.readAt).toBeNull();

    const result = await inboxMarkRead(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(true);
    expect((await readEntry(id)).readAt).not.toBeNull();
  });

  it('inbox_mark_read is idempotent: a second call keeps read_at set, no error', async () => {
    const id = await insertEntry(member.id);
    const first = await inboxMarkRead(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_trace_id: generateTraceId(),
    });
    expect(first.ok).toBe(true);
    expect((await readEntry(id)).readAt).not.toBeNull();

    const second = await inboxMarkRead(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_trace_id: generateTraceId(),
    });
    expect(second.ok).toBe(true);
    expect((await readEntry(id)).readAt).not.toBeNull();
  });

  it('inbox_mark_read never touches another user row', async () => {
    const ownerEntry = await insertEntry(owner.id);
    const result = await inboxMarkRead(clientFor(member.id), {
      p_entry_id: ownerEntry,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_trace_id: generateTraceId(),
    });
    // The proc affects 0 rows but does not error; the owner row stays unread.
    expect(result.ok).toBe(true);
    expect((await readEntry(ownerEntry)).readAt).toBeNull();
  });

  it('inbox_mark_read rejects a non-member', async () => {
    const id = await insertEntry(member.id);
    const result = await inboxMarkRead(clientFor(outsider.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workspace_member_only');
  });

  it('inbox_mark_all_read clears unread rows but leaves snoozed ones', async () => {
    const unreadA = await insertEntry(member.id);
    const unreadB = await insertEntry(member.id);
    const snoozed = await insertEntry(member.id, { snoozed_until: '2026-07-20T00:00:00.000Z' });

    const result = await inboxMarkAllRead(clientFor(member.id), {
      p_workspace_id: ws.id,
      p_trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(true);
    expect((await readEntry(unreadA)).readAt).not.toBeNull();
    expect((await readEntry(unreadB)).readAt).not.toBeNull();
    expect((await readEntry(snoozed)).readAt).toBeNull();
  });

  it('inbox_snooze sets snoozed_until and clear un-snoozes', async () => {
    const id = await insertEntry(member.id);
    const snooze = await inboxSnooze(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_kind: '1h',
      p_trace_id: generateTraceId(),
    });
    expect(snooze.ok).toBe(true);
    expect((await readEntry(id)).snoozedUntil).not.toBeNull();

    const clear = await inboxSnooze(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_kind: 'clear',
      p_trace_id: generateTraceId(),
    });
    expect(clear.ok).toBe(true);
    expect((await readEntry(id)).snoozedUntil).toBeNull();
  });

  it('inbox_snooze rejects an invalid kind', async () => {
    const id = await insertEntry(member.id);
    const result = await inboxSnooze(clientFor(member.id), {
      p_entry_id: id,
      p_workspace_id: ws.id,
      p_created_at: partitionTimestamp,
      p_kind: 'bogus',
      p_trace_id: generateTraceId(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('invalid_snooze_kind');
  });
});
