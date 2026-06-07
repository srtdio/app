// RLS coverage for the brief read path, exercised through the @srtdio/briefs
// read functions so the test proves the same SELECT path the app uses. The
// briefs SELECT policies are: agency-tier members (owner/admin/agency) see every
// non-deleted brief in their workspace; a client sees only briefs it created.
// Cross-workspace, nobody sees another tenant's briefs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  createBrief,
  getBrief,
  listBriefs,
  type Client,
  type Result,
} from '../../packages/briefs/src/index';

const BRIEFS_SUITE = process.env.BRIEFS_SUITE === '1';

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

describe.runIf(BRIEFS_SUITE)('briefs RLS visibility', () => {
  let admin: SupabaseClient<Database>;

  let owner: SeededUser;
  let agencyUser: SeededUser;
  let clientOne: SeededUser;
  let clientTwo: SeededUser;
  let wsA: SeededWorkspace;

  let outsider: SeededUser;
  let wsB: SeededWorkspace;

  let briefOne: string; // created by clientOne
  let briefTwo: string; // created by clientTwo

  async function addMember(workspaceId: string, user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  async function createAs(user: SeededUser, title: string): Promise<string> {
    const result = await createBrief(
      clientFor(user.id) as Client,
      { workspaceId: wsA.id, title, objective: 'O' },
      generateTraceId(),
    );
    return expectOk(result).id;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `RLS A ${owner.email}`);

    agencyUser = await seedUser(env, admin);
    await addMember(wsA.id, agencyUser, 'agency');
    clientOne = await seedUser(env, admin);
    await addMember(wsA.id, clientOne, 'client');
    clientTwo = await seedUser(env, admin);
    await addMember(wsA.id, clientTwo, 'client');

    outsider = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, outsider, `RLS B ${outsider.email}`);

    briefOne = await createAs(clientOne, 'Client one brief');
    briefTwo = await createAs(clientTwo, 'Client two brief');
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, agencyUser, clientOne, clientTwo, outsider]);
  });

  it('a client lists only the briefs it created', async () => {
    const ids = expectOk(await listBriefs(clientFor(clientOne.id))).map((b) => b.id);
    expect(ids).toContain(briefOne);
    expect(ids).not.toContain(briefTwo);
  });

  it('a client cannot getBrief a brief another client created', async () => {
    expect(expectOk(await getBrief(clientFor(clientOne.id), briefTwo))).toBeNull();
  });

  it('an agency member sees every brief in the workspace', async () => {
    const ids = expectOk(await listBriefs(clientFor(agencyUser.id))).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([briefOne, briefTwo]));
  });

  it('the owner sees every brief in the workspace', async () => {
    expect(expectOk(await getBrief(clientFor(owner.id), briefOne))).not.toBeNull();
    expect(expectOk(await getBrief(clientFor(owner.id), briefTwo))).not.toBeNull();
  });

  it('a member of another workspace sees none of these briefs', async () => {
    const ids = expectOk(await listBriefs(clientFor(outsider.id))).map((b) => b.id);
    expect(ids).not.toContain(briefOne);
    expect(ids).not.toContain(briefTwo);
    expect(expectOk(await getBrief(clientFor(outsider.id), briefOne))).toBeNull();
  });
});
