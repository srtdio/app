// Integration coverage for the Activity write path: the three user-callable
// read-state / snooze procs (inbox_mark_read, inbox_mark_all_read, inbox_snooze)
// run AS an authenticated member via the RLS suite's per-user client (clientFor),
// asserted against inbox_entries ground truth read through the service role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  loadRlsEnv,
  seedUser,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import { insertFull, seedInboxWorkspace, type InboxWorkspace } from './helpers';

const INBOX_SUITE = process.env.INBOX_SUITE === '1';
// A created_at inside the partition the baseline ships (mid-2026); the procs gate
// the target row to p_created_at's month partition, so seed and arg agree.
const PARTITION = '2026-06-15T00:00:00.000Z';
const FUTURE = '2026-06-20T00:00:00.000Z';

interface EntryState {
  id: string;
  read_at: string | null;
  snoozed_until: string | null;
}

describe.runIf(INBOX_SUITE)('inbox read-state procs (integration)', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  async function freshWorkspace(): Promise<InboxWorkspace> {
    const ws = await seedInboxWorkspace(env, admin);
    workspaces.push({ id: ws.workspaceId, name: 'Inbox', ownerId: ws.owner.id });
    users.push(...ws.users);
    return ws;
  }

  async function seedEntry(
    ws: InboxWorkspace,
    userId: string,
    over: Record<string, unknown> = {},
  ): Promise<EntryState> {
    return insertFull<EntryState>(admin, 'inbox_entries', {
      user_id: userId,
      workspace_id: ws.workspaceId,
      event_type: 'comment',
      scope: 'everything',
      tier: 'active',
      created_at: PARTITION,
      ...over,
    });
  }

  async function readEntry(id: string): Promise<EntryState> {
    const res = await admin
      .from('inbox_entries')
      .select('id, read_at, snoozed_until')
      .eq('id', id)
      .limit(1);
    if (res.error) throw new Error(`read inbox_entries failed: ${res.error.message}`);
    const row = (res.data as EntryState[] | null)?.[0];
    if (row === undefined) throw new Error(`entry ${id} not found`);
    return row;
  }

  beforeAll(() => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  // Args are built as identifiers (never inline .rpc literals) so the trace-id
  // lint, which only flags inline objects, stays satisfied while p_trace_id is
  // always supplied, mirroring grant.test.ts.
  function markReadArgs(ws: InboxWorkspace, entryId: string) {
    return {
      p_entry_id: entryId,
      p_workspace_id: ws.workspaceId,
      p_created_at: PARTITION,
      p_trace_id: generateTraceId(),
    };
  }

  function snoozeArgs(ws: InboxWorkspace, entryId: string, kind: string) {
    return {
      p_entry_id: entryId,
      p_workspace_id: ws.workspaceId,
      p_created_at: PARTITION,
      p_kind: kind,
      p_trace_id: generateTraceId(),
    };
  }

  function markAllArgs(ws: InboxWorkspace) {
    return { p_workspace_id: ws.workspaceId, p_trace_id: generateTraceId() };
  }

  it('inbox_mark_read sets read_at, is idempotent, and never touches another user row', async () => {
    const ws = await freshWorkspace();
    const mine = await seedEntry(ws, ws.owner.id);
    const theirs = await seedEntry(ws, ws.client.id);
    const authed = clientFor(ws.owner.id);

    const first = await authed.rpc('inbox_mark_read', markReadArgs(ws, mine.id));
    expect(first.error).toBeNull();
    const afterFirst = await readEntry(mine.id);
    expect(afterFirst.read_at).not.toBeNull();

    // Idempotent: a second call leaves the original read_at untouched (no error).
    const second = await authed.rpc('inbox_mark_read', markReadArgs(ws, mine.id));
    expect(second.error).toBeNull();
    expect((await readEntry(mine.id)).read_at).toBe(afterFirst.read_at);

    // Another user's row is never affected (user_id = auth.uid() gate).
    const cross = await authed.rpc('inbox_mark_read', markReadArgs(ws, theirs.id));
    expect(cross.error).toBeNull();
    expect((await readEntry(theirs.id)).read_at).toBeNull();
  });

  it('a non-member call raises workspace_member_only', async () => {
    const ws = await freshWorkspace();
    const mine = await seedEntry(ws, ws.owner.id);
    const outsider = await seedUser(env, admin);
    users.push(outsider);

    const res = await clientFor(outsider.id).rpc('inbox_mark_read', markReadArgs(ws, mine.id));
    expect(res.error).not.toBeNull();
    expect(res.error?.message).toContain('workspace_member_only');
  });

  it('inbox_snooze sets snoozed_until, clear nulls it, and an invalid kind raises', async () => {
    const ws = await freshWorkspace();
    const entry = await seedEntry(ws, ws.owner.id);
    const authed = clientFor(ws.owner.id);

    const snoozed = await authed.rpc('inbox_snooze', snoozeArgs(ws, entry.id, '1h'));
    expect(snoozed.error).toBeNull();
    expect((await readEntry(entry.id)).snoozed_until).not.toBeNull();

    const cleared = await authed.rpc('inbox_snooze', snoozeArgs(ws, entry.id, 'clear'));
    expect(cleared.error).toBeNull();
    expect((await readEntry(entry.id)).snoozed_until).toBeNull();

    const invalid = await authed.rpc('inbox_snooze', snoozeArgs(ws, entry.id, 'bogus'));
    expect(invalid.error).not.toBeNull();
    expect(invalid.error?.message).toContain('invalid_snooze_kind');
  });

  it('inbox_mark_all_read marks only the caller unread, non-snoozed rows in the workspace', async () => {
    const ws = await freshWorkspace();
    const unread = await seedEntry(ws, ws.owner.id);
    const snoozed = await seedEntry(ws, ws.owner.id, { snoozed_until: FUTURE });
    const alreadyRead = await seedEntry(ws, ws.owner.id, { read_at: PARTITION });
    const otherUser = await seedEntry(ws, ws.client.id);

    const res = await clientFor(ws.owner.id).rpc('inbox_mark_all_read', markAllArgs(ws));
    expect(res.error).toBeNull();

    expect((await readEntry(unread.id)).read_at).not.toBeNull();
    expect((await readEntry(snoozed.id)).read_at).toBeNull();
    expect((await readEntry(alreadyRead.id)).read_at).toBe(alreadyRead.read_at);
    expect((await readEntry(otherUser.id)).read_at).toBeNull();
  });
});
