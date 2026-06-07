// Idempotency: replaying the same source event through processEvent with the
// same KV dedupe namespace must produce zero additional inbox entries. The KV
// key is hash(source_table | source_id | event_type | recipient_user_id), so a
// second pass finds every key present and writes nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  cleanupWorkspaces,
  createAdminClient,
  loadRlsEnv,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import { processEvent } from '../../workers/inbox-writer/src/process';
import type { CommentRow, PostRow } from '../../packages/inbox/src/index';
import { entriesFor, inMemoryKv, insertFull, makeDeps, seedInboxWorkspace } from './helpers';

const INBOX_SUITE = process.env.INBOX_SUITE === '1';

describe.runIf(INBOX_SUITE)('inbox-writer idempotency', () => {
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  const workspaces: SeededWorkspace[] = [];
  const users: SeededUser[] = [];

  beforeAll(() => {
    env = loadRlsEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, workspaces, users);
  });

  it('a replayed comment event writes zero new entries the second time', async () => {
    const ws = await seedInboxWorkspace(env, admin);
    workspaces.push({ id: ws.workspaceId, name: 'Inbox', ownerId: ws.owner.id });
    users.push(...ws.users);

    const post = await insertFull<PostRow>(admin, 'posts', {
      workspace_id: ws.workspaceId,
      title: 'Post',
      bucket_id: ws.bucketId,
      owner_user_id: ws.owner.id,
      platform: 'linkedin',
      format: 'text',
      created_by: ws.owner.id,
    });
    const comment = await insertFull<CommentRow>(admin, 'comments', {
      workspace_id: ws.workspaceId,
      entity_type: 'post',
      entity_id: post.id,
      author_user_id: ws.client.id,
      body: 'hi',
      mentions: [ws.admin.id],
    });

    const kv = inMemoryKv();
    const deps = makeDeps(env, admin, kv);
    const event = { table: 'comments', type: 'INSERT', row: comment } as const;

    const first = await processEvent(event, deps);
    const afterFirst =
      (await entriesFor(admin, ws.workspaceId, 'comment')).length +
      (await entriesFor(admin, ws.workspaceId, 'mention')).length;
    expect(first.written).toBe(afterFirst);
    expect(first.written).toBeGreaterThan(0);
    expect(first.deduped).toBe(0);

    const second = await processEvent(event, deps);
    const afterSecond =
      (await entriesFor(admin, ws.workspaceId, 'comment')).length +
      (await entriesFor(admin, ws.workspaceId, 'mention')).length;

    expect(second.written).toBe(0);
    expect(second.deduped).toBe(first.written);
    expect(afterSecond).toBe(afterFirst);
  });
});
