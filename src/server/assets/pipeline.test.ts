import { describe, expect, it } from 'vitest';
import { InMemoryStorageClient } from '@srtdio/storage';
import { InMemoryAssetRepository } from './repository';
import { runUploadPipeline, renameAsset, type PipelineDeps } from './pipeline';
import { NoOpScanner } from './virus-scan';
import type { AssetRow, FolderRow, UploadInput } from './types';

const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const USER = '33333333-3333-7333-8333-333333333333';
const FOLDER = '88888888-8888-7888-8888-888888888888';
const TRACE = 'trace-pipeline';

/** The label the UI shows: display_name when set, else the original filename. */
function displayLabel(asset: AssetRow): string {
  return asset.display_name ?? asset.filename;
}

function makeDeps(): { deps: PipelineDeps; repo: InMemoryAssetRepository } {
  const repo = new InMemoryAssetRepository();
  const deps: PipelineDeps = {
    storage: new InMemoryStorageClient(),
    repository: repo,
    scanner: new NoOpScanner(),
  };
  return { deps, repo };
}

function seedFolder(repo: InMemoryAssetRepository, name: string): void {
  const now = new Date().toISOString();
  const folder: FolderRow = {
    id: FOLDER,
    workspace_id: WORKSPACE,
    name,
    parent_id: null,
    created_by: USER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  repo.folders.set(FOLDER, folder);
}

/** A valid (magic-byte-passing) PDF upload; `salt` varies the bytes -> sha. */
function pdfUpload(salt: number, extra: Partial<UploadInput> = {}): UploadInput {
  return {
    workspaceId: WORKSPACE,
    uploadedBy: USER,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, salt]),
    traceId: TRACE,
    ...extra,
  };
}

function findByDisplayName(repo: InMemoryAssetRepository, name: string): AssetRow {
  for (const asset of repo.assets.values()) {
    if (asset.display_name === name) {
      return asset;
    }
  }
  throw new Error(`no asset with display_name ${name}`);
}

describe('runUploadPipeline folder auto-naming', () => {
  it('auto-names uploads "<folder> 1", "<folder> 2", monotonic past a deletion', async () => {
    const { deps, repo } = makeDeps();
    seedFolder(repo, 'Photos');

    const first = await runUploadPipeline(deps, pdfUpload(1, { folderId: FOLDER }));
    expect(first.ok).toBe(true);
    expect(repo.assets.get(first.ok ? first.value.assetId : '')?.display_name).toBe('Photos 1');

    const second = await runUploadPipeline(deps, pdfUpload(2, { folderId: FOLDER }));
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.value.assetId : '';
    expect(repo.assets.get(secondId)?.display_name).toBe('Photos 2');

    // Soft-delete "Photos 2"; its number must not be handed back out (monotonic).
    const toDelete = findByDisplayName(repo, 'Photos 2');
    repo.assets.set(toDelete.id, { ...toDelete, deleted_at: new Date().toISOString() });

    const third = await runUploadPipeline(deps, pdfUpload(3, { folderId: FOLDER }));
    expect(third.ok).toBe(true);
    expect(repo.assets.get(third.ok ? third.value.assetId : '')?.display_name).toBe('Photos 3');
  });

  it('every folder upload keeps filename = the original upload name', async () => {
    const { deps, repo } = makeDeps();
    seedFolder(repo, 'Photos');
    const res = await runUploadPipeline(deps, pdfUpload(1, { folderId: FOLDER }));
    expect(res.ok).toBe(true);
    const asset = repo.assets.get(res.ok ? res.value.assetId : '');
    expect(asset?.filename).toBe('report.pdf');
    expect(asset?.folder_id).toBe(FOLDER);
  });
});

describe('runUploadPipeline display_name at root', () => {
  it('a supplied display_name is stored; filename stays the original', async () => {
    const { deps, repo } = makeDeps();
    const res = await runUploadPipeline(deps, pdfUpload(1, { displayName: 'Quarterly deck' }));
    expect(res.ok).toBe(true);
    const asset = repo.assets.get(res.ok ? res.value.assetId : '');
    expect(asset?.display_name).toBe('Quarterly deck');
    expect(asset?.filename).toBe('report.pdf');
    expect(asset?.folder_id).toBeNull();
  });

  it('a root upload with no display_name leaves display_name null', async () => {
    const { deps, repo } = makeDeps();
    const res = await runUploadPipeline(deps, pdfUpload(1));
    expect(res.ok).toBe(true);
    expect(repo.assets.get(res.ok ? res.value.assetId : '')?.display_name).toBeNull();
  });

  it('a supplied display_name wins over folder auto-naming', async () => {
    const { deps, repo } = makeDeps();
    seedFolder(repo, 'Photos');
    const res = await runUploadPipeline(
      deps,
      pdfUpload(1, { folderId: FOLDER, displayName: 'Hand named' }),
    );
    expect(res.ok).toBe(true);
    expect(repo.assets.get(res.ok ? res.value.assetId : '')?.display_name).toBe('Hand named');
  });
});

describe('renameAsset', () => {
  async function seedRootUpload(
    deps: PipelineDeps,
    extra: Partial<UploadInput> = {},
  ): Promise<string> {
    const res = await runUploadPipeline(deps, pdfUpload(1, extra));
    if (!res.ok) {
      throw new Error('seed upload failed');
    }
    return res.value.assetId;
  }

  it('writes display_name and leaves filename (and its extension) intact', async () => {
    const { deps, repo } = makeDeps();
    const assetId = await seedRootUpload(deps);

    const res = await renameAsset(repo, {
      workspaceId: WORKSPACE,
      assetId,
      name: 'Final report',
      actorUserId: USER,
      traceId: TRACE,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.displayName).toBe('Final report');
      expect(res.value.filename).toBe('report.pdf');
    }
    const asset = repo.assets.get(assetId);
    // filename keeps its extension, so the type glyph is preserved.
    expect(asset?.filename).toBe('report.pdf');
    expect(asset?.display_name).toBe('Final report');

    const audit = repo.audits.find((a) => a.action === 'asset.rename');
    expect(audit?.payload).toMatchObject({ display_name: 'Final report', previous_display_name: null });
  });

  it('changes the resolved displayLabel of an auto-named folder asset', async () => {
    const { deps, repo } = makeDeps();
    seedFolder(repo, 'Photos');
    const assetId = await seedRootUpload(deps, { folderId: FOLDER });
    expect(displayLabel(repo.assets.get(assetId)!)).toBe('Photos 1');

    await renameAsset(repo, {
      workspaceId: WORKSPACE,
      assetId,
      name: 'Beach trip',
      actorUserId: USER,
      traceId: TRACE,
    });
    expect(displayLabel(repo.assets.get(assetId)!)).toBe('Beach trip');
  });
});
