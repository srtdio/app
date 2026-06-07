// Guards the "briefs are read-only after creation" invariant. There is no
// update wrapper, no brief_update proc, and no brief-update edge function: the
// only mutation a brief ever undergoes is the open -> closed flip via brief_close.
//
// Three angles: the package exposes no update/patch/edit surface; no brief-update
// edge function route exists on disk; and at the database level an authenticated
// UPDATE on briefs is denied (no UPDATE grant or policy), so a would-be edit
// changes zero rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  seedUser,
  seedWorkspace,
  updateRowCount,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import * as briefs from '../../packages/briefs/src/index';
import { createBrief, type Client } from '../../packages/briefs/src/index';

const BRIEFS_SUITE = process.env.BRIEFS_SUITE === '1';

describe('briefs are read-only: no update surface', () => {
  it('the package exports create/close/read and nothing update-shaped', () => {
    const names = Object.keys(briefs);
    expect(names).toEqual(
      expect.arrayContaining(['createBrief', 'closeBrief', 'listBriefs', 'getBrief']),
    );
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/update|patch|edit/);
    }
  });

  it('no brief-update edge function route exists', () => {
    const functionsDir = resolve(__dirname, '../../supabase/functions');
    expect(existsSync(resolve(functionsDir, 'brief-create/index.ts'))).toBe(true);
    expect(existsSync(resolve(functionsDir, 'brief-close/index.ts'))).toBe(true);
    expect(existsSync(resolve(functionsDir, 'brief-update'))).toBe(false);
    expect(existsSync(resolve(functionsDir, 'brief-edit'))).toBe(false);
  });
});

describe.runIf(BRIEFS_SUITE)('briefs are read-only: database denies edits', () => {
  let admin: SupabaseClient<Database>;
  let owner: SeededUser;
  let clientUser: SeededUser;
  let wsA: SeededWorkspace;
  let briefId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `NoUpdate ${owner.email}`);
    clientUser = await seedUser(env, admin);
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: wsA.id,
      user_id: clientUser.id,
      role: 'client',
      active: true,
      accepted_at: new Date().toISOString(),
    });

    const created = await createBrief(
      clientFor(clientUser.id) as Client,
      { workspaceId: wsA.id, title: 'Frozen', objective: 'O' },
      generateTraceId(),
    );
    if (!created.ok) throw new Error(`seed createBrief failed: ${created.error.code}`);
    briefId = created.data.id;
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA], [owner, clientUser]);
  });

  it('an authenticated UPDATE on the brief affects zero rows', async () => {
    const affected = await updateRowCount(
      asGeneric(clientFor(clientUser.id)),
      'briefs',
      [['id', briefId]],
      { title: 'Edited' },
    );
    expect(affected).toBe(0);

    const res = await asGeneric(admin).from('briefs').select('title').eq('id', briefId);
    const rows = res.data as Array<{ title: string }> | null;
    expect(rows?.[0]?.title).toBe('Frozen');
  });
});
