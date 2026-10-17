// Fixtures for the chat-file purge and Delete workspace specs. Everything here
// is additive over installHarnessNetwork: the spec registers these routes after
// the harness, so they answer first. Names and ids are fictional.

import type { Page, Route } from '@playwright/test';
import { DM_CHANNEL, WORKSPACE_ID, assetId, type ChatWorld } from './chat-data';
import type { Row } from './postgrest';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

/** The own DM message that carries a file (n = 38, the last own DM row). */
export const FILE_MESSAGE_BODY = 'Final brief attached for sign off';
export const FILE_NAME = 'launch-brief.pdf';
export const FILE_ASSET_ID = assetId(1, 381);
/** An own text-only DM message (n = 36). */
export const TEXT_MESSAGE_BODY = 'Text only line, nothing attached';

export const WORKSPACE_NAME = 'Harness Studio';

function dmRow(world: ChatWorld, n: number): Row {
  const row = world.dmMessages[n - 1];
  if (row === undefined || row.channel_id !== DM_CHANNEL) throw new Error(`no DM row ${n}`);
  return row;
}

/** Give the last own DM message a PDF and make an earlier own one plainly text-only. */
export function seedChatFile(world: ChatWorld): { fileMessageId: string; textMessageId: string } {
  const file = dmRow(world, 38);
  file.body = FILE_MESSAGE_BODY;
  file.attachment_asset_ids = [FILE_ASSET_ID];
  file.attachment_meta = {
    [FILE_ASSET_ID]: { mime: 'application/pdf', name: FILE_NAME, size: 120_000 },
  };
  const text = dmRow(world, 36);
  text.body = TEXT_MESSAGE_BODY;
  text.attachment_asset_ids = null;
  text.attachment_meta = null;
  return { fileMessageId: String(file.id), textMessageId: String(text.id) };
}

export interface DeleteRecorder {
  /** 'rpc:chat_message_delete' and 'purge-chat' in the order the page sent them. */
  order: string[];
  deleteArgs: Array<Record<string, unknown>>;
  purgeBodies: Array<Record<string, unknown>>;
  purgeAuth: string[];
  workspaceDeleteArgs: Array<Record<string, unknown>>;
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * chat_message_delete (soft-deletes the rows, as the proc does), the
 * asset-upload Worker's POST /purge-chat, and workspace_delete (the row stops
 * listing, as RLS would once it is gone).
 */
export async function installDeleteRoutes(page: Page, world: ChatWorld): Promise<DeleteRecorder> {
  const recorder: DeleteRecorder = {
    order: [],
    deleteArgs: [],
    purgeBodies: [],
    purgeAuth: [],
    workspaceDeleteArgs: [],
  };
  await page.route('**/rest/v1/rpc/chat_message_delete', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    recorder.order.push('rpc:chat_message_delete');
    recorder.deleteArgs.push(args);
    const ids = Array.isArray(args.p_message_ids) ? args.p_message_ids.map(String) : [];
    const now = new Date().toISOString();
    for (const m of world.tables.chat_messages ?? []) {
      if (ids.includes(String(m.id))) {
        m.deleted_at = now;
        m.body = null;
        m.attachment_asset_ids = null;
        m.attachment_meta = null;
      }
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
    recorder.purgeAuth.push((await request.allHeaders()).authorization ?? '');
    await json(route, 200, { removed: 1, freedBytes: 120_000 });
  });
  await page.route('**/rest/v1/rpc/workspace_delete', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    recorder.workspaceDeleteArgs.push(args);
    const rows = world.tables.workspaces ?? [];
    const index = rows.findIndex((w) => w.id === args.p_workspace_id);
    if (index >= 0) rows.splice(index, 1);
    await json(route, 200, null);
  });
  return recorder;
}

/** Make someone else the owner: the harness user becomes an agency member. */
export function makeNonOwner(world: ChatWorld, ownerId: string, me: string): void {
  for (const w of world.tables.workspaces ?? []) {
    if (w.id === WORKSPACE_ID) w.owner_user_id = ownerId;
  }
  for (const m of world.tables.workspace_members ?? []) {
    if (m.user_id === me) m.role = 'agency';
    if (m.user_id === ownerId) m.role = 'owner';
  }
}

/** Move both seeded messages inside the 30 min delete window (text first, then the file). */
export function makeRecent(world: ChatWorld, now: number = Date.now()): void {
  dmRow(world, 36).created_at = new Date(now - 5 * 60_000).toISOString();
  dmRow(world, 38).created_at = new Date(now - 4 * 60_000).toISOString();
}
