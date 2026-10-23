import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import {
  CHIP_BATCH_TIMEOUT_MS,
  PostRefChip,
  createChipBatch,
} from '@/components/chat/PostRefChip';
import { aboutState, chipPostIds, parentIndexOf } from '@/lib/chat/post-refs';
import type { ThreadMessage } from '@/lib/chat/thread';

function cardRow(id: string, number: number): PostCardRow {
  return {
    id,
    number,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'single_image',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
  };
}

type Row = Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds'>;
const card = (id: string, postId: string): Row => ({ id, sharedPostIds: [postId], reply: null });
const chipReply = (id: string, parent: string): Row => ({
  id,
  sharedPostIds: [],
  reply: { id: parent, authorUserId: null, preview: 'Shared post' },
});

describe('createChipBatch', () => {
  it('reads once per distinct set of new ids, never per chip', async () => {
    const load = vi.fn((ids: string[]) =>
      Promise.resolve({ ok: true as const, data: ids.map((id, i) => cardRow(id, i + 1)) }),
    );
    const batch = createChipBatch(load);

    // A page with five chips over two posts: one read.
    const page = [
      card('c1', 'p1'),
      card('c2', 'p2'),
      chipReply('r1', 'c1'),
      chipReply('r2', 'c1'),
      chipReply('r3', 'c2'),
      chipReply('r4', 'c2'),
      chipReply('r5', 'c1'),
    ];
    const ids = chipPostIds(page, parentIndexOf(page));
    await batch.request(ids);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(['p1', 'p2']);
    expect(batch.get('p1')?.number).toBe(1);

    // Re-renders with the same set read nothing.
    expect(batch.request(ids)).toBeNull();
    expect(batch.request(['p2', 'p1', 'p1'])).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    // An older page brings one new post: one more read, for that id only.
    const older = [card('c0', 'p3'), chipReply('r0', 'c0'), ...page];
    await batch.request(chipPostIds(older, parentIndexOf(older)));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(['p3']);
  });

  it('a post a completed read did not return (RLS) resolves to null; a failed read does not', async () => {
    const batch = createChipBatch((ids) =>
      Promise.resolve({ ok: true as const, data: [cardRow(ids[0] ?? '', 1)] }),
    );
    expect(batch.get('a')).toBeUndefined();
    await batch.request(['a', 'hidden']);
    expect(batch.get('a')?.id).toBe('a');
    expect(batch.get('hidden')).toBeNull();

    vi.useFakeTimers();
    const failing = createChipBatch(() => Promise.reject(new Error('down')));
    const done = failing.request(['x']);
    await vi.advanceTimersByTimeAsync(CHIP_BATCH_TIMEOUT_MS);
    await done;
    expect(failing.get('x')).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('PostRefChip', () => {
  const post = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };

  it('is a 44px tap target around a 24px pill: 18px round thumb and the title', () => {
    const html = renderToStaticMarkup(<PostRefChip post={post} onTap={() => {}} />);
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('h-6');
    expect(html).toContain('rounded-full');
    expect(html).toContain('h-[18px] w-[18px]');
    expect(html).toMatch(/truncate[^>]*>Launch teaser</);
    // The bubble long-press ignores it, like a link.
    expect(html).toContain('data-msg-link=""');
  });

  it('tap shows the post and never reaches the bubble', () => {
    const onTap = vi.fn();
    const el = PostRefChip({ post, onTap });
    const stopPropagation = vi.fn();
    (el.props as { onClick: (e: { stopPropagation: () => void }) => void }).onClick({
      stopPropagation,
    });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('never shows a KEY-N code: no key span, the label names the title', () => {
    const html = renderToStaticMarkup(<PostRefChip post={post} onTap={() => {}} />);
    expect(html).not.toContain('data-post-ref-key');
    expect(html).not.toContain('font-mono');
    expect(html).toContain('aria-label="Go to the card about Launch teaser"');
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });
});

describe('createChipBatch timeout (R5)', () => {
  it('a timed-out read leaves its ids unknown and retryable, never null; About stays pending', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<never>(() => {}));
    const batch = createChipBatch(load);
    const done = batch.request(['slow']);
    expect(batch.get('slow')).toBeUndefined();
    expect(batch.attempted('slow')).toBe(false);
    vi.advanceTimersByTime(CHIP_BATCH_TIMEOUT_MS);
    await done;
    expect(batch.get('slow')).toBeUndefined();
    expect(batch.attempted('slow')).toBe(true);
    expect(aboutState(batch.get('slow'))).toBe('pending');
    // The next request retries it.
    expect(batch.request(['slow'])).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a failed read leaves its ids unknown and retryable, never null; About stays pending', async () => {
    vi.useFakeTimers();
    for (const failing of [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve({ ok: false as const, error: { code: 'transport', message: 'down' } }),
    ]) {
      const load = vi.fn(failing);
      const batch = createChipBatch(load as Parameters<typeof createChipBatch>[0]);
      const done = batch.request(['p']);
      await vi.advanceTimersByTimeAsync(1);
      // The failure landed at once; the ids are held until the window ends.
      expect(batch.get('p')).toBeUndefined();
      expect(batch.request(['p'])).toBeNull();
      await vi.advanceTimersByTimeAsync(CHIP_BATCH_TIMEOUT_MS);
      await done;
      expect(batch.get('p')).toBeUndefined();
      expect(batch.attempted('p')).toBe(true);
      expect(aboutState(batch.get('p'))).toBe('pending');
      expect(batch.request(['p'])).not.toBeNull();
      expect(load).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });

  it('two fast failures in a row make at most one re-request per window', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    const batch = createChipBatch(load as Parameters<typeof createChipBatch>[0]);
    // The hook's loop: every settled request asks again for the same ids.
    const loop = (): void => {
      void batch.request(['p'])?.then(loop);
    };
    loop();
    await vi.advanceTimersByTimeAsync(CHIP_BATCH_TIMEOUT_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHIP_BATCH_TIMEOUT_MS);
    expect(load).toHaveBeenCalledTimes(3);
    expect(batch.get('p')).toBeUndefined();
    vi.useRealTimers();
  });

  it('a completed read that returns nothing resolves null (About goes)', async () => {
    const batch = createChipBatch(() => Promise.resolve({ ok: true as const, data: [] }));
    await batch.request(['hidden']);
    expect(batch.get('hidden')).toBeNull();
    expect(aboutState(batch.get('hidden'))).toBe('gone');
    expect(batch.request(['hidden'])).toBeNull();
  });
});
