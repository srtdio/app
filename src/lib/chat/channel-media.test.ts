import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  CHANNEL_MEDIA_PAGE_SIZE,
  listChannelAttachments,
  listChannelLinks,
  splitMediaFiles,
  toAttachmentItems,
  toLinkItems,
} from '@/lib/chat/channel-media';
import { olderThanFilter } from '@/lib/chat/history';
import { APP_ENTITY_ROUTES } from '@/lib/chat/message-links';

interface Call {
  method: string;
  args: unknown[];
}

// Recording PostgREST-ish builder, as in history.test.ts.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'not', 'ilike', 'or', 'order', 'limit']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return b;
  });
  return { client: { from } as unknown as Client, calls };
}

const CHANNEL = 'dm__ws__a__b';
const CURSOR = { createdAt: '2026-09-22T10:00:00.123456+00:00', id: 'm-old' };
const ORIGIN = 'https://srtd.io';

function row(over: Record<string, unknown>) {
  return {
    id: 'm1',
    sender_user_id: 'u1',
    attachment_asset_ids: ['v1'],
    attachment_meta: { v1: { mime: 'image/png', name: 'a.png', size: 10 } },
    created_at: '2026-09-22T10:00:00+00:00',
    body: null,
    ...over,
  };
}

describe('listChannelAttachments', () => {
  it('one keyset-paged read: filters, order, limit', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await listChannelAttachments(client, { channelId: CHANNEL });
    expect(calls).toEqual([
      { method: 'from', args: ['chat_messages'] },
      {
        method: 'select',
        args: ['id, sender_user_id, attachment_asset_ids, attachment_meta, created_at'],
      },
      { method: 'eq', args: ['channel_id', CHANNEL] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'not', args: ['attachment_asset_ids', 'is', null] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [CHANNEL_MEDIA_PAGE_SIZE] },
    ]);
    expect(CHANNEL_MEDIA_PAGE_SIZE).toBe(50);
  });

  it('continues before the cursor with the (created_at, id) keyset', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await listChannelAttachments(client, { channelId: CHANNEL, before: CURSOR });
    expect(calls.filter((c) => c.method === 'or')).toEqual([
      { method: 'or', args: [olderThanFilter(CURSOR)] },
    ]);
    expect(calls.filter((c) => c.method === 'from')).toHaveLength(1);
  });

  it('maps rows to items, a full page has more, cursor is the oldest row', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ id: `m${i}`, created_at: `2026-09-22T10:00:${String(59 - i).padStart(2, '0')}+00:00` }),
    );
    const { client } = makeClient({ data: rows, error: null });
    const result = await listChannelAttachments(client, { channelId: CHANNEL });
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.items).toHaveLength(50);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.cursor).toEqual({ id: 'm49', createdAt: rows[49]?.created_at });
  });

  it('a short page has no more; an error is a failed Result', async () => {
    const ok = await listChannelAttachments(makeClient({ data: [row({})], error: null }).client, {
      channelId: CHANNEL,
    });
    expect(ok.ok && ok.data.hasMore).toBe(false);
    const bad = await listChannelAttachments(
      makeClient({ data: null, error: { message: 'boom' } }).client,
      { channelId: CHANNEL },
    );
    expect(bad.ok).toBe(false);
  });
});

describe('toAttachmentItems + splitMediaFiles', () => {
  it('maps meta to items, one per version id in row order', () => {
    const items = toAttachmentItems([
      row({
        attachment_asset_ids: ['v1', 'v2'],
        attachment_meta: {
          v1: { mime: 'image/jpeg', name: 'p.jpg', size: 100 },
          v2: { mime: 'application/pdf', name: 'd.pdf', size: 2048 },
        },
      }),
    ]);
    expect(items).toEqual([
      {
        messageId: 'm1',
        versionId: 'v1',
        name: 'p.jpg',
        mime: 'image/jpeg',
        size: 100,
        createdAt: '2026-09-22T10:00:00+00:00',
        senderUserId: 'u1',
      },
      {
        messageId: 'm1',
        versionId: 'v2',
        name: 'd.pdf',
        mime: 'application/pdf',
        size: 2048,
        createdAt: '2026-09-22T10:00:00+00:00',
        senderUserId: 'u1',
      },
    ]);
  });

  it('a legacy id without meta has mime "" and lists as a file; video is a file; voice notes are dropped', () => {
    const items = toAttachmentItems([
      row({ id: 'm2', attachment_asset_ids: ['legacy'], attachment_meta: null }),
      row({
        id: 'm3',
        attachment_asset_ids: ['vid', 'img', 'voice'],
        attachment_meta: {
          vid: { mime: 'video/mp4', name: 'v.mp4', size: 1 },
          voice: { mime: 'audio/webm', name: 'voice.webm', size: 1, duration_ms: 3000 },
          img: { mime: 'image/webp', name: 'i.webp', size: 1 },
        },
      }),
    ]);
    expect(items[0]).toMatchObject({ versionId: 'legacy', mime: '', name: '', size: null });
    const { images, files } = splitMediaFiles(items);
    expect(images.map((i) => i.versionId)).toEqual(['img']);
    expect(files.map((i) => i.versionId)).toEqual(['legacy', 'vid']);
  });
});

describe('listChannelLinks', () => {
  it('one keyset-paged read on bodies that may hold a url', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await listChannelLinks(client, {
      channelId: CHANNEL,
      before: CURSOR,
      appOrigin: ORIGIN,
      routes: APP_ENTITY_ROUTES,
    });
    expect(calls).toEqual([
      { method: 'from', args: ['chat_messages'] },
      { method: 'select', args: ['id, sender_user_id, body, created_at'] },
      { method: 'eq', args: ['channel_id', CHANNEL] },
      { method: 'is', args: ['deleted_at', null] },
      { method: 'ilike', args: ['body', '%http%'] },
      { method: 'or', args: [olderThanFilter(CURSOR)] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [50] },
    ]);
  });

  it('extracts external urls and excludes internal post or brief links', () => {
    const items = toLinkItems(
      [
        row({
          id: 'l1',
          body: `see https://example.com/a, and ${ORIGIN}/p/SRT-12 plus http://x.io/q?z=1.`,
        }),
        row({ id: 'l2', body: 'no link here, just http talk' }),
        row({ id: 'l3', body: `${ORIGIN}/settings is ours but not a card` }),
      ],
      ORIGIN,
      APP_ENTITY_ROUTES,
    );
    expect(items.map((i) => [i.messageId, i.url])).toEqual([
      ['l1', 'https://example.com/a'],
      ['l1', 'http://x.io/q?z=1'],
      ['l3', `${ORIGIN}/settings`],
    ]);
    expect(items[0]).toMatchObject({ senderUserId: 'u1', createdAt: '2026-09-22T10:00:00+00:00' });
  });
});
