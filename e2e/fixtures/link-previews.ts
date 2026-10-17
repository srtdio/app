import type { Page } from '@playwright/test';
import type { ChatWorld } from './chat-data';
import { PEER, POST_IDS, WORKSPACE_ID } from './chat-data';
import { solidPng } from './harness-routes';

// Link-preview Worker stub (the host the harness Vite config points
// VITE_LINK_PREVIEW_URL at) plus the chat and comment bodies that carry links.

export const LINK_PREVIEW_HOST = 'link-preview.harness.test';

export const FULL_URL = 'https://www.instagram.com/p/C9x2/';
export const FULL_TITLE = 'Northwind Foods on Instagram: "Festive hampers are here"';
export const LOGIN_URL = 'https://drive.google.com/file/d/1aX9/view';
export const UNSAFE_URL = 'http://g00gle-docs-share.top:8080/login?next=x';
export const COMMENT_URL = 'https://www.youtube.com/watch?v=hamper45';
export const COMMENT_TITLE = 'Unboxing a festive hamper in 45 seconds';

export const FULL_LINE = `Reference for the reel tone ${FULL_URL}`;
export const LOGIN_LINE = `Final logo files ${LOGIN_URL}`;
export const UNSAFE_LINE = `pls see this asap ${UNSAFE_URL}`;
export const COMMENT_LINE = `Make the opening like this one ${COMMENT_URL}`;

const BASE = { finalDomain: null, viaShortener: null };

const ANSWERS: Record<string, unknown> = {
  [FULL_URL]: {
    type: 'full',
    domain: 'instagram.com',
    path: '/p/C9x2/',
    letter: 'I',
    ...BASE,
    title: FULL_TITLE,
    description: '1,204 likes. Our Diwali range ships from 20 Oct across India.',
    siteName: 'Instagram',
    video: false,
    durationSeconds: null,
  },
  [LOGIN_URL]: {
    type: 'login',
    domain: 'drive.google.com',
    path: '/file/d/1aX9/view',
    letter: 'D',
    ...BASE,
  },
  [COMMENT_URL]: {
    type: 'full',
    domain: 'youtube.com',
    path: '/watch?v=hamper45',
    letter: 'Y',
    ...BASE,
    title: COMMENT_TITLE,
    description: null,
    siteName: 'YouTube',
    video: true,
    durationSeconds: 45,
  },
};

/** Put the link lines on the DM's last three messages and one comment on the first post. */
export function seedLinkBodies(world: ChatWorld, now: number = Date.now()): void {
  const rows = world.dmMessages;
  const lines = [FULL_LINE, LOGIN_LINE, UNSAFE_LINE];
  lines.forEach((line, k) => {
    const row = rows[rows.length - lines.length + k];
    if (row !== undefined) row.body = line;
  });
  (world.tables.comments ??= []).push({
    id: '0190f200-0000-7000-8000-0000000000c1',
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: POST_IDS[0],
    author_user_id: PEER,
    body: COMMENT_LINE,
    parent_comment_id: null,
    attachment_asset_ids: null,
    mentions: null,
    created_at: new Date(now - 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    legacy_author_name: null,
    legacy_author_email: null,
    ledger_seq: null,
    ledger_batch_id: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    resolution_note: null,
    asked_at: null,
    asked_by: null,
    sent_back_at: null,
    sent_back_by: null,
    closed_at: null,
    closed_by: null,
    accepted_at: null,
    accepted_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
  });
}

export interface LinkPreviewStub {
  /** Every link the page asked the Worker to preview, in order. */
  requested: string[];
  /** Hold /preview answers until release() (to see the reserved skeleton). */
  hold: () => { release: () => void };
}

/** Answer /preview and /image on the stub host. Registered after installHarnessNetwork. */
export async function installLinkPreviewStub(page: Page): Promise<LinkPreviewStub> {
  const requested: string[] = [];
  let gate: Promise<void> | null = null;
  const png = solidPng(382, 200, [214, 69, 122]);
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, x-trace-id',
    'access-control-allow-methods': 'GET, OPTIONS',
  };
  await page.route(`https://${LINK_PREVIEW_HOST}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    const target = url.searchParams.get('url') ?? '';
    if (url.pathname === '/image') {
      await route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'image/png' },
        body: png,
      });
      return;
    }
    requested.push(target);
    if (gate !== null) await gate;
    const answer = ANSWERS[target] ?? {
      type: 'bare',
      domain: new URL(target).hostname,
      path: '',
      letter: '?',
      ...BASE,
    };
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(answer),
    });
  });
  return {
    requested,
    hold: () => {
      let release = (): void => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return { release };
    },
  };
}
