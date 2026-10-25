import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { refreshedState } from '@/components/chat/ChatStoreProvider';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { approvedWithoutName } from '@/components/chat/PostCard';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { READ_TIMEOUT_MS, withLateRead, type ChatProfile } from '@/lib/chat-reads';
import {
  applyUnreadCounts,
  initialState,
  loadScope,
  type ChatStoreState,
} from '@/lib/chat/chat-store';
import { CHAT_UPLOAD_FAILED, chatUploadMessage } from '@/lib/chat/attachments';
import { uploadErrorMessage } from '@/lib/asset-upload';
import { createSharedCardCache } from '@/lib/chat/shared-cards';
import { ownEditApplier } from '@/lib/chat/use-chat-thread';
import type { ChatMessageRow } from '@/lib/chat/thread';

afterEach(() => {
  vi.useRealTimers();
});

const SCOPE = loadScope('w1', 'me');

function state(): ChatStoreState {
  return {
    ...initialState(),
    scope: SCOPE,
    status: 'ready',
    conversations: { c1: { lastMessageText: 'hi', lastMessageTs: 1, unread: 3 } },
  };
}

describe('refresh keeps values on failure; no write after a switch', () => {
  const fail: Result<never> = { ok: false, error: { code: 'unknown', message: 'x' } };

  it('a failed unread refresh keeps the current counts', () => {
    const prev = state();
    expect(refreshedState(prev, SCOPE, fail, applyUnreadCounts)).toBe(prev);
  });

  it('an answer for a scope the store moved on from is dropped', () => {
    const prev = state();
    const other = loadScope('w2', 'me');
    const ok = { ok: true as const, data: [] };
    expect(refreshedState(prev, other, ok, applyUnreadCounts)).toBe(prev);
    expect(refreshedState(prev, SCOPE, ok, applyUnreadCounts).conversations.c1?.unread).toBe(0);
  });

  it('a read cancelled before its deadline settles and never delivers late', async () => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    const onLate = vi.fn();
    let resolveRead: (r: Result<number>) => void = () => {};
    const first = withLateRead(
      () =>
        new Promise<Result<number>>((r) => {
          resolveRead = r;
        }),
      { onLate, cancel: cancel.signal },
    );
    cancel.abort();
    expect(await first).toMatchObject({ ok: false });
    resolveRead({ ok: true, data: 1 });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(onLate).not.toHaveBeenCalled();
  });
});

describe('onMessageEdited wiring (own edit)', () => {
  const row = { id: 'm1', body: 'new', edited_at: '2026-09-30T10:00:00Z' } as ChatMessageRow;

  it('the list line always hears it; the thread updates only if the chat is still open', () => {
    const onEdited = vi.fn();
    const update = vi.fn();
    ownEditApplier({ forChannel: 'c1', openChannel: () => 'c1', onEdited, update })(row);
    expect(onEdited).toHaveBeenCalledWith(row);
    expect(update).toHaveBeenCalledTimes(1);
    expect(typeof update.mock.calls[0]?.[0]).toBe('function');
    const later = vi.fn();
    ownEditApplier({ forChannel: 'c1', openChannel: () => 'c2', onEdited, update: later })(row);
    expect(onEdited).toHaveBeenCalledTimes(2);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('SharedCardsProvider coalescing (the thread ask plus every card, same tick)', () => {
  it('60 cards across posts and briefs: 1 posts read, 1 briefs read, 1 names read', async () => {
    const readPosts = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: ids.map((id) => ({ id, approved_by: `u-${id}` })),
    }));
    const readBriefs = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: ids.map((id) => ({ id })),
    }));
    const readNames = vi.fn(
      async (ids: string[]): Promise<Result<ChatProfile[]>> => ({
        ok: true,
        data: ids.map((userId) => ({ userId, displayName: userId, avatarUrl: null })),
      }),
    );
    const cache = createSharedCardCache({
      readPosts,
      readBriefs,
      readNames,
      postId: (p: { id: string }) => p.id,
      briefId: (b: { id: string }) => b.id,
      approverIds: (posts: readonly { approved_by: string }[]) => posts.map((p) => p.approved_by),
    });
    const postIds = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const briefIds = Array.from({ length: 20 }, (_, i) => `b${i}`);
    // Children's effects run before the provider's in one commit.
    postIds.forEach((id) => cache.request({ postIds: [id] }));
    briefIds.forEach((id) => cache.request({ briefIds: [id] }));
    cache.request({ postIds, briefIds });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(readPosts).toHaveBeenCalledTimes(1);
    expect(readBriefs).toHaveBeenCalledTimes(1);
    expect(readNames).toHaveBeenCalledTimes(1);
  });
});

describe('draggable attributes on chat media', () => {
  it('bubble images and the file link are draggable=false', async () => {
    const deps: PresignDeps = {
      endpoint: 'https://asset-read',
      getAccessToken: async () => 'tok',
      fetcher: async () =>
        new Response(
          JSON.stringify({ url: 'https://signed/x', expires_at: '2999-01-01T00:00:00Z' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    };
    const cache = new PresignCache(deps);
    const img = '11111111-1111-4111-8111-111111111111';
    const pdf = '22222222-2222-4222-8222-222222222222';
    await cache.resolve(img);
    await cache.resolve(pdf);
    const html = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          { assetId: img, name: 'p.png', mime: 'image/png' },
          { assetId: pdf, name: 'a.pdf', mime: 'application/pdf' },
        ]}
        cache={cache}
        presignEnabled
      />,
    );
    expect(html).toMatch(/<img[^>]*draggable="false"/);
    // The file is a FileBubble button now (in-app viewer), never a link out.
    expect(html).toContain('data-file-bubble="pdf"');
    expect(html).not.toMatch(/<a[^>]*target="_blank"/);
    const album = renderToStaticMarkup(
      <MessageAttachments
        attachments={[
          { assetId: img, name: 'p.png', mime: 'image/png' },
          { assetId: img, name: 'q.png', mime: 'image/png' },
        ]}
        cache={cache}
        presignEnabled
        album
        onImageClick={() => {}}
      />,
    );
    const imgs = album.match(/<img[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((tag) => tag.includes('draggable="false"'))).toBe(true);
  });
});

describe('E11: approved card with no loaded approver name', () => {
  it('reads "Approved · <date time>" from approved_at', () => {
    const footer = approvedWithoutName(
      { state: 'Approved · Sep 29', action: 'Open' },
      { stage: 'approved', approved_at: '2026-09-30T10:05:00Z' },
      null,
      'UTC',
    );
    expect(footer.state).toBe('Approved · 30 Sep, 10:05 AM');
    const named = { state: 'Approved by Ana', action: 'Open' };
    expect(approvedWithoutName(named, { stage: 'approved', approved_at: 'x' }, 'Ana', 'UTC')).toBe(
      named,
    );
  });
});

describe('T3: chat upload failures carry no connection wording', () => {
  it('the generic upload failure becomes neutral chat copy; named reasons stay', () => {
    expect(chatUploadMessage(uploadErrorMessage('network'))).toBe(CHAT_UPLOAD_FAILED);
    expect(CHAT_UPLOAD_FAILED).not.toMatch(/connection|network|internet|offline/i);
    expect(chatUploadMessage('Files up to 100MB only')).toBe('Files up to 100MB only');
  });
});
