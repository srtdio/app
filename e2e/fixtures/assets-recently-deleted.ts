// Fixture rows and route overrides for the Recently deleted specs: library
// assets (live and deleted, with their current version embedded the way the
// PostgREST stand-in returns rows), an attachment that ties one live asset to a
// live post, and stand-ins for asset_delete, asset_restore and the asset-upload
// Worker's POST /purge. Routes are registered after installHarnessNetwork, so
// they win over the shared harness handler.

import type { Page, Route } from '@playwright/test';
import type { HarnessNetwork } from './harness-routes';
import type { Row } from './postgrest';
import { WORKSPACE_ID } from './chat-data';

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

/** A live library image that a live post still attaches. */
export const IN_USE_ID = '0190ea00-0000-7000-8000-000000000001';
export const IN_USE_NAME = 'Hero banner.png';
/** A live library image that nothing attaches. */
export const FREE_ID = '0190ea00-0000-7000-8000-000000000002';
export const FREE_NAME = 'Spare shot.png';

/** Deleted files: 1 day ago (2 MB) and 10 days ago (a long unbroken name, 3 MB). */
export const DELETED_RECENT_ID = '0190ea00-0000-7000-8000-000000000011';
export const DELETED_RECENT_NAME = 'Old logo.png';
export const DELETED_LONG_ID = '0190ea00-0000-7000-8000-000000000012';
export const DELETED_LONG_NAME =
  'Quarterly_campaign_final_final_v7_approved_by_client_with_new_logo_and_colours_2026.pdf';
export const DELETED_RECENT_BYTES = 2 * MB;
export const DELETED_LONG_BYTES = 3 * MB;
export const DELETED_RECENT_AGO_DAYS = 1;
export const DELETED_LONG_AGO_DAYS = 10;

/** Another workspace member, made owner for the member view. */
export const OTHER_OWNER = '0190a000-0000-7000-8000-0000000000ff';

function assetRow(input: {
  id: string;
  name: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
  deletedAt: string | null;
}): Row {
  const version = input.id.replace('0190ea00', '0190eb00');
  return {
    id: input.id,
    workspace_id: WORKSPACE_ID,
    origin: 'library',
    filename: input.name,
    display_name: null,
    folder_path: '/',
    folder_id: null,
    tags: [],
    uploaded_at: input.uploadedAt,
    current_version_id: version,
    current_version: {
      id: version,
      asset_id: input.id,
      kind: input.kind,
      mime_type: input.mime,
      size_bytes: input.sizeBytes,
      width: null,
      height: null,
      duration_ms: null,
      page_count: null,
      external_url: null,
      r2_key: `${WORKSPACE_ID}/${input.id}/v1`,
      version_number: 1,
    },
    deleted_at: input.deletedAt,
    purge_requested_at: null,
  };
}

/** Seed the library, Recently deleted and the in-use attachment into the world. */
export function seedRecentlyDeleted(network: HarnessNetwork, now: number = Date.now()): void {
  const t = network.world.tables;
  const postId = String((t.posts ?? [])[0]?.id);
  const iso = (ms: number): string => new Date(ms).toISOString();
  (t.assets ??= []).push(
    assetRow({
      id: IN_USE_ID,
      name: IN_USE_NAME,
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 400_000,
      uploadedAt: iso(now - 60_000),
      deletedAt: null,
    }),
    assetRow({
      id: FREE_ID,
      name: FREE_NAME,
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 300_000,
      uploadedAt: iso(now - 120_000),
      deletedAt: null,
    }),
    assetRow({
      id: DELETED_RECENT_ID,
      name: DELETED_RECENT_NAME,
      kind: 'image',
      mime: 'image/png',
      sizeBytes: DELETED_RECENT_BYTES,
      uploadedAt: iso(now - 40 * DAY_MS),
      deletedAt: iso(now - DELETED_RECENT_AGO_DAYS * DAY_MS - 60_000),
    }),
    assetRow({
      id: DELETED_LONG_ID,
      name: DELETED_LONG_NAME,
      kind: 'pdf',
      mime: 'application/pdf',
      sizeBytes: DELETED_LONG_BYTES,
      uploadedAt: iso(now - 40 * DAY_MS),
      deletedAt: iso(now - DELETED_LONG_AGO_DAYS * DAY_MS - 60_000),
    }),
  );
  (t.asset_attachments ??= []).push({
    id: '0190ec00-0000-7000-8000-000000000001',
    workspace_id: WORKSPACE_ID,
    asset_id: IN_USE_ID,
    entity_type: 'post',
    entity_id: postId,
    attached_at: iso(now - 30_000),
    deleted_at: null,
  });
}

/** The post the in-use attachment points at. */
export function inUsePostId(network: HarnessNetwork): string {
  return String((network.world.tables.posts ?? [])[0]?.id);
}

/** Make another user the workspace owner, so ME is a plain member. */
export function makeMeMember(network: HarnessNetwork): void {
  const ws = (network.world.tables.workspaces ?? [])[0];
  if (ws !== undefined) ws.owner_user_id = OTHER_OWNER;
}

export interface DeletedRoutes {
  /** asset_delete / asset_restore calls, with their JSON args. */
  rpc: Array<{ name: string; args: Record<string, unknown> }>;
  /** POST /purge bodies, in order. */
  purges: Array<Record<string, unknown>>;
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * asset_delete raises asset_in_use for any asset a live attachment holds and
 * otherwise soft-deletes; asset_restore clears deleted_at; POST /purge marks
 * the given (or all deleted) rows purge_requested_at, so the re-read drops them.
 */
export async function installDeletedRoutes(
  page: Page,
  network: HarnessNetwork,
): Promise<DeletedRoutes> {
  const calls: DeletedRoutes = { rpc: [], purges: [] };
  const t = network.world.tables;
  const find = (id: unknown): Row | undefined => (t.assets ?? []).find((a) => a.id === id);

  await page.route(/\/rest\/v1\/rpc\/asset_(delete|restore)$/, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.rpc.push({ name, args });
    const asset = find(args.p_asset_id);
    if (name === 'asset_delete') {
      const held = (t.asset_attachments ?? []).some(
        (a) => a.asset_id === args.p_asset_id && a.deleted_at === null,
      );
      if (held) {
        await json(route, 400, {
          code: 'P0001',
          message: 'asset_in_use',
          details: null,
          hint: null,
        });
        return;
      }
      if (asset !== undefined) asset.deleted_at = new Date().toISOString();
    } else if (asset !== undefined) {
      asset.deleted_at = null;
    }
    await json(route, 200, null);
  });

  await page.route('https://asset-upload.harness.test/purge', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.purges.push(body);
    const ids = Array.isArray(body.asset_ids) ? body.asset_ids.map(String) : null;
    const due = (t.assets ?? []).filter(
      (a) =>
        a.deleted_at !== null &&
        a.purge_requested_at === null &&
        (ids === null || ids.includes(String(a.id))),
    );
    let freedBytes = 0;
    for (const row of due) {
      row.purge_requested_at = new Date().toISOString();
      freedBytes += Number((row.current_version as Row | null)?.size_bytes ?? 0);
    }
    await json(route, 200, { requested: due.length, removed: due.length, freedBytes });
  });

  return calls;
}
