// Fixtures for "Chat - remove files, keep the message": own photos, a peer's
// photo and an own single file in the DM, a message that already lost files
// (removed_files counts), plus chat_message_remove_files (rewrites the rows as
// the proc does) and the asset-upload Worker's POST /purge-chat. Additive over
// installHarnessNetwork: the spec registers these routes after the harness, so
// they answer first. Names and ids are fictional.

import type { Page, Route } from '@playwright/test';
import { DM_CHANNEL, ME, PEER, assetId, type ChatWorld } from './chat-data';
import type { Row } from './postgrest';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

/** An own album of two photos (DM row 34). */
export const ALBUM_BODY = 'Two crops for the hero';
export const ALBUM_PHOTOS = [
  { id: assetId(1, 901), name: 'hero-crop-1.png' },
  { id: assetId(1, 902), name: 'hero-crop-2.png' },
] as const;
/** A peer's photo (DM row 35): never selectable, no bin. */
export const PEER_PHOTO = { id: assetId(1, 911), name: 'peer-moodboard.png' } as const;
/** An own message with one file and text (DM row 36): More -> Remove file. */
export const SINGLE_FILE_BODY = 'Contract draft attached';
export const SINGLE_FILE = { id: assetId(1, 921), name: 'contract-draft.pdf' } as const;
/** An own message that already lost two photos and kept its text (DM row 32). */
export const REMOVED_BODY = 'Kept the caption, dropped the old shots';

function dmRow(world: ChatWorld, n: number): Row {
  const row = world.dmMessages[n - 1];
  if (row === undefined || row.channel_id !== DM_CHANNEL) throw new Error(`no DM row ${n}`);
  return row;
}

function photoMeta(name: string): Record<string, unknown> {
  return { mime: 'image/png', name, size: 48_000, thumb_w: 640, thumb_h: 480 };
}

/** Seed the DM: own album, a peer's photo, an own single file. */
export function seedRemovableFiles(world: ChatWorld): void {
  const album = dmRow(world, 34);
  Object.assign(album, {
    sender_user_id: ME,
    body: ALBUM_BODY,
    attachment_asset_ids: ALBUM_PHOTOS.map((p) => p.id),
    attachment_meta: Object.fromEntries(ALBUM_PHOTOS.map((p) => [p.id, photoMeta(p.name)])),
    removed_files: {},
  });
  const peer = dmRow(world, 35);
  Object.assign(peer, {
    sender_user_id: PEER,
    body: 'My moodboard for reference',
    attachment_asset_ids: [PEER_PHOTO.id],
    attachment_meta: { [PEER_PHOTO.id]: photoMeta(PEER_PHOTO.name) },
    removed_files: {},
  });
  const single = dmRow(world, 36);
  Object.assign(single, {
    sender_user_id: ME,
    body: SINGLE_FILE_BODY,
    attachment_asset_ids: [SINGLE_FILE.id],
    attachment_meta: {
      [SINGLE_FILE.id]: { mime: 'application/pdf', name: SINGLE_FILE.name, size: 120_000 },
    },
    removed_files: {},
  });
}

/** Seed an own DM message whose two photos were already removed (the bubble's line). */
export function seedRemovedLine(world: ChatWorld): void {
  Object.assign(dmRow(world, 32), {
    sender_user_id: ME,
    body: REMOVED_BODY,
    attachment_asset_ids: null,
    attachment_meta: null,
    removed_files: { photo: 2 },
  });
}

export interface RemoveFilesRecorder {
  /** 'rpc:chat_message_remove_files' and 'purge-chat' in the order the page sent them. */
  order: string[];
  removeArgs: Array<Record<string, unknown>>;
  purgeBodies: Array<Record<string, unknown>>;
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function kindOf(mime: unknown): 'photo' | 'video' | 'file' {
  const m = typeof mime === 'string' ? mime : '';
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * chat_message_remove_files over the fixture rows, as the proc writes them:
 * the ids and their meta entries go, the kinds count into removed_files, and a
 * message left with nothing becomes a tombstone. Own files only.
 */
function removeFiles(world: ChatWorld, args: Record<string, unknown>): string | null {
  const messageIds = Array.isArray(args.p_message_ids) ? args.p_message_ids.map(String) : [];
  const assetIds = Array.isArray(args.p_asset_ids) ? args.p_asset_ids.map(String) : [];
  if (assetIds.length === 0 || assetIds.length > 100) return 'select between 1 and 100 files';
  const rows = (world.tables.chat_messages ?? []).filter(
    (m) => messageIds.includes(String(m.id)) && m.channel_id === args.p_channel_id,
  );
  const owned = assetIds.every((id) =>
    rows.some((m) => {
      const ids = (m.attachment_asset_ids as string[] | null) ?? [];
      const meta = (m.attachment_meta as Record<string, { mime?: string }> | null) ?? {};
      return (
        m.sender_user_id === ME &&
        m.deleted_at === null &&
        ids.includes(id) &&
        !(meta[id]?.mime ?? '').startsWith('audio/')
      );
    }),
  );
  if (!owned) return 'only your own files can be removed';
  const now = new Date().toISOString();
  for (const m of rows) {
    const ids = (m.attachment_asset_ids as string[] | null) ?? [];
    const meta = { ...((m.attachment_meta as Record<string, { mime?: string }> | null) ?? {}) };
    const counts = { ...((m.removed_files as Record<string, number> | null) ?? {}) };
    const gone = ids.filter((id) => assetIds.includes(id));
    if (gone.length === 0) continue;
    for (const id of gone) {
      const kind = kindOf(meta[id]?.mime);
      counts[kind] = (counts[kind] ?? 0) + 1;
      delete meta[id];
    }
    const left = ids.filter((id) => !assetIds.includes(id));
    const body = typeof m.body === 'string' ? m.body.trim() : '';
    if (left.length === 0 && body === '') {
      Object.assign(m, {
        deleted_at: now,
        body: null,
        attachment_asset_ids: null,
        attachment_meta: null,
      });
    } else {
      Object.assign(m, {
        attachment_asset_ids: left.length > 0 ? left : null,
        attachment_meta: Object.keys(meta).length > 0 ? meta : null,
        removed_files: counts,
      });
    }
  }
  return null;
}

/** chat_message_remove_files and POST /purge-chat, recorded in order. */
export async function installRemoveFilesRoutes(
  page: Page,
  world: ChatWorld,
): Promise<RemoveFilesRecorder> {
  const recorder: RemoveFilesRecorder = { order: [], removeArgs: [], purgeBodies: [] };
  await page.route('**/rest/v1/rpc/chat_message_remove_files', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    recorder.order.push('rpc:chat_message_remove_files');
    recorder.removeArgs.push(args);
    const refused = removeFiles(world, args);
    if (refused !== null) {
      await json(route, 400, { code: 'P0001', message: refused, details: null, hint: null });
      return;
    }
    await json(route, 200, null);
  });
  await page.route('https://asset-upload.harness.test/purge-chat', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    recorder.order.push('purge-chat');
    recorder.purgeBodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
    await json(route, 200, { removed: 1, freedBytes: 48_000 });
  });
  return recorder;
}
