// RLS coverage for the brief read path, exercised through the @srtdio/briefs
// read functions so the test proves the same SELECT path the app uses. The
// briefs SELECT policies are: agency-tier members (owner/admin/agency) see every
// non-deleted brief in their workspace; a client sees every non-deleted brief in
// its workspace too (open and closed, regardless of author), but only while its
// membership is active. Cross-workspace, nobody sees another tenant's briefs.

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
  nextEntityNumber,
  partitionTimestamp,
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
  let inactiveClient: SeededUser;
  let wsA: SeededWorkspace;

  let outsider: SeededUser;
  let clientInB: SeededUser;
  let wsB: SeededWorkspace;

  let briefOne: string; // created by clientOne
  let briefTwo: string; // created by clientTwo
  let briefByAgency: string; // created by the agency member
  let briefClosed: string; // status = 'closed'

  async function addMember(
    workspaceId: string,
    user: SeededUser,
    role: string,
    active = true,
  ): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active,
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

  // Insert a brief directly through the service role (bypassing the create proc)
  // so a test can pin its author and status without depending on who is allowed
  // to create or close a brief. Reuses the suite's number allocator.
  async function seedBrief(
    creator: SeededUser,
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const g = asGeneric(admin);
    const row = await insertRow(g, 'briefs', {
      workspace_id: wsA.id,
      number: await nextEntityNumber(g, wsA.id),
      title,
      objective: 'O',
      created_by: creator.id,
      ...extra,
    });
    return String(row.id);
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
    inactiveClient = await seedUser(env, admin);
    await addMember(wsA.id, inactiveClient, 'client', false);

    outsider = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, outsider, `RLS B ${outsider.email}`);
    clientInB = await seedUser(env, admin);
    await addMember(wsB.id, clientInB, 'client');

    briefOne = await createAs(clientOne, 'Client one brief');
    briefTwo = await createAs(clientTwo, 'Client two brief');
    briefByAgency = await seedBrief(agencyUser, 'Agency authored brief');
    briefClosed = await seedBrief(agencyUser, 'Closed brief', {
      status: 'closed',
      closed_at: partitionTimestamp,
      closed_by: owner.id,
    });
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [wsA, wsB],
      [owner, agencyUser, clientOne, clientTwo, inactiveClient, outsider, clientInB],
    );
  });

  it('a client sees every brief in its workspace, including one another client made', async () => {
    const ids = expectOk(await listBriefs(clientFor(clientOne.id))).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([briefOne, briefTwo]));
  });

  it('a client can getBrief a brief another client created', async () => {
    expect(expectOk(await getBrief(clientFor(clientOne.id), briefTwo))).not.toBeNull();
  });

  it('a client sees a brief authored by an agency member', async () => {
    const ids = expectOk(await listBriefs(clientFor(clientOne.id))).map((b) => b.id);
    expect(ids).toContain(briefByAgency);
    expect(expectOk(await getBrief(clientFor(clientOne.id), briefByAgency))).not.toBeNull();
  });

  it('a client sees a closed brief in its workspace', async () => {
    const ids = expectOk(await listBriefs(clientFor(clientOne.id))).map((b) => b.id);
    expect(ids).toContain(briefClosed);
    const found = expectOk(await getBrief(clientFor(clientOne.id), briefClosed));
    expect(found).not.toBeNull();
    expect(found?.brief.status).toBe('closed');
  });

  it('an agency member sees every brief in the workspace', async () => {
    const ids = expectOk(await listBriefs(clientFor(agencyUser.id))).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([briefOne, briefTwo, briefByAgency, briefClosed]));
  });

  it('the owner sees every brief in the workspace', async () => {
    expect(expectOk(await getBrief(clientFor(owner.id), briefOne))).not.toBeNull();
    expect(expectOk(await getBrief(clientFor(owner.id), briefTwo))).not.toBeNull();
  });

  it('a client of another workspace sees none of these briefs', async () => {
    const ids = expectOk(await listBriefs(clientFor(clientInB.id))).map((b) => b.id);
    expect(ids).not.toContain(briefOne);
    expect(ids).not.toContain(briefTwo);
    expect(ids).not.toContain(briefByAgency);
    expect(ids).not.toContain(briefClosed);
    expect(expectOk(await getBrief(clientFor(clientInB.id), briefOne))).toBeNull();
  });

  it('a member of another workspace sees none of these briefs', async () => {
    const ids = expectOk(await listBriefs(clientFor(outsider.id))).map((b) => b.id);
    expect(ids).not.toContain(briefOne);
    expect(ids).not.toContain(briefTwo);
    expect(expectOk(await getBrief(clientFor(outsider.id), briefOne))).toBeNull();
  });

  it('an inactive client sees zero briefs', async () => {
    const ids = expectOk(await listBriefs(clientFor(inactiveClient.id))).map((b) => b.id);
    expect(ids).toHaveLength(0);
    expect(expectOk(await getBrief(clientFor(inactiveClient.id), briefOne))).toBeNull();
  });
});
