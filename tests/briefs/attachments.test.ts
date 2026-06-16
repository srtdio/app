// End-to-end coverage for brief_create's optional attachment_asset_version_ids,
// run against a local, ephemeral Supabase stack (same bring-up as the briefs
// integration suite). Briefs are immutable after creation, so creation is the
// only attach point: an ordered list of asset_version ids (any kind) is bound to
// the new brief as asset_attachments rows with entity_type='brief', position =
// array order. Writes run as the AUTHENTICATED client member through createBrief;
// the service-role admin client only seeds asset_versions and reads ground truth.
//
// Covered: all three kinds attach in order (image / document / link); the
// empty/absent case still creates a brief with zero attachments; a cross-tenant
// asset_version id is rejected with invalid_payload and writes nothing; and two
// malformed shapes (not a JSON array, an array with a non-uuid string) both
// raise invalid_payload.

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
  randomSha256,
  seedUser,
  seedWorkspace,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  createBrief,
  type Client,
  type DomainError,
  type Result,
} from '../../packages/briefs/src/index';

const BRIEFS_SUITE = process.env.BRIEFS_SUITE === '1';

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function expectError<T>(result: Result<T>): DomainError {
  if (result.ok) throw new Error('expected an error result, got ok');
  return result.error;
}

interface AttachmentRow {
  entity_type: string;
  entity_id: string;
  asset_version_id: string;
  asset_id: string;
  position: number;
}

describe.runIf(BRIEFS_SUITE)('brief_create attachments (authenticated client member)', () => {
  let admin: SupabaseClient<Database>;

  let owner: SeededUser;
  let clientUser: SeededUser;
  let wsA: SeededWorkspace;
  let clientClient: Client;

  let ownerB: SeededUser;
  let wsB: SeededWorkspace;

  async function addMember(workspaceId: string, user: SeededUser, role: string): Promise<void> {
    await insertRow(asGeneric(admin), 'workspace_members', {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      active: true,
      accepted_at: new Date().toISOString(),
    });
  }

  // Seed an asset + one asset_version of the given kind in the workspace and
  // return the version id. Links carry external_url and null byte columns; image
  // and document versions carry an r2_key + mime, mirroring the upload pipeline.
  async function seedVersion(
    workspaceId: string,
    uploadedBy: string,
    kind: 'image' | 'document' | 'link',
  ): Promise<string> {
    const g = asGeneric(admin);
    const asset = await insertRow(g, 'assets', {
      workspace_id: workspaceId,
      filename: `${kind}.bin`,
      uploaded_by: uploadedBy,
    });
    const base = {
      asset_id: asset.id,
      workspace_id: workspaceId,
      version_number: 1,
      kind,
      uploaded_by: uploadedBy,
    };
    const fields =
      kind === 'link'
        ? { ...base, external_url: 'https://example.com/ref' }
        : {
            ...base,
            r2_key: `key/${crypto.randomUUID()}`,
            mime_type: kind === 'image' ? 'image/png' : 'application/pdf',
            sha256: randomSha256(),
            size_bytes: 1,
          };
    const version = await insertRow(g, 'asset_versions', fields);
    return String(version.id);
  }

  async function readBriefAttachments(briefId: string): Promise<AttachmentRow[]> {
    const res = await asGeneric(admin)
      .from('asset_attachments')
      .select('entity_type,entity_id,asset_version_id,asset_id,position')
      .eq('entity_type', 'brief')
      .eq('entity_id', briefId);
    const rows = (res.data as AttachmentRow[] | null) ?? [];
    // The typed test builder cannot chain .order(); sort by position in memory.
    return [...rows].sort((a, b) => a.position - b.position);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);

    owner = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Brief attach A ${owner.email}`);

    clientUser = await seedUser(env, admin);
    await addMember(wsA.id, clientUser, 'client');
    clientClient = clientFor(clientUser.id);

    ownerB = await seedUser(env, admin);
    wsB = await seedWorkspace(admin, ownerB, `Brief attach B ${ownerB.email}`);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [owner, clientUser, ownerB]);
  });

  it('attaches all three kinds in order as entity_type=brief asset_attachments', async () => {
    const imageId = await seedVersion(wsA.id, owner.id, 'image');
    const docId = await seedVersion(wsA.id, owner.id, 'document');
    const linkId = await seedVersion(wsA.id, owner.id, 'link');

    const created = expectOk(
      await createBrief(
        clientClient,
        {
          workspaceId: wsA.id,
          title: 'Brief with attachments',
          objective: 'Attach image, document, and link',
          attachmentAssetVersionIds: [imageId, docId, linkId],
        },
        generateTraceId(),
      ),
    );

    const rows = await readBriefAttachments(created.id);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.entity_type === 'brief' && r.entity_id === created.id)).toBe(true);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.asset_version_id)).toEqual([imageId, docId, linkId]);
  });

  it('creates the brief with zero attachments when the field is absent', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        { workspaceId: wsA.id, title: 'No attachments', objective: 'None' },
        generateTraceId(),
      ),
    );
    expect(await readBriefAttachments(created.id)).toEqual([]);
  });

  it('creates the brief with zero attachments when the field is an empty array', async () => {
    const created = expectOk(
      await createBrief(
        clientClient,
        {
          workspaceId: wsA.id,
          title: 'Empty attachments',
          objective: 'Empty',
          attachmentAssetVersionIds: [],
        },
        generateTraceId(),
      ),
    );
    expect(await readBriefAttachments(created.id)).toEqual([]);
  });

  it('rejects a cross-tenant asset_version id with invalid_payload, writing nothing', async () => {
    const foreignId = await seedVersion(wsB.id, ownerB.id, 'image');

    const before = await asGeneric(admin)
      .from('briefs')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsA.id);

    const result = await createBrief(
      clientClient,
      {
        workspaceId: wsA.id,
        title: 'Cross tenant',
        objective: 'Should fail',
        attachmentAssetVersionIds: [foreignId],
      },
      generateTraceId(),
    );
    expect(expectError(result).code).toBe('invalid_payload');

    // No brief was inserted (count unchanged) and the foreign version has no
    // brief attachment bound to it.
    const after = await asGeneric(admin)
      .from('briefs')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', wsA.id);
    expect(after.count).toBe(before.count);

    const attach = await asGeneric(admin)
      .from('asset_attachments')
      .select('id')
      .eq('entity_type', 'brief')
      .eq('asset_version_id', foreignId);
    expect((attach.data as unknown[] | null) ?? []).toEqual([]);
  });

  it('rejects a non-array attachment field with invalid_payload', async () => {
    const result = await createBrief(
      clientClient,
      {
        workspaceId: wsA.id,
        title: 'Bad shape',
        objective: 'Not an array',
        // Bypass the string[] type to exercise the proc's jsonb_typeof guard.
        attachmentAssetVersionIds: 'nope' as unknown as string[],
      },
      generateTraceId(),
    );
    expect(expectError(result).code).toBe('invalid_payload');
  });

  it('rejects an array containing a non-uuid string with invalid_payload', async () => {
    const result = await createBrief(
      clientClient,
      {
        workspaceId: wsA.id,
        title: 'Bad id',
        objective: 'Non uuid element',
        attachmentAssetVersionIds: ['not-a-uuid'],
      },
      generateTraceId(),
    );
    expect(expectError(result).code).toBe('invalid_payload');
  });
});
