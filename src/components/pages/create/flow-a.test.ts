// Post flow A: the New post sheet's pure helpers, one regression per fix.
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { FORMATS_BY_PLATFORM } from '@srtdio/posts';
import { formatForFile, untouchedDefaultFormat } from '@/components/pages/create/file-kind';
import { createLimiter, UPLOAD_CONCURRENCY } from '@/components/pages/create/limiter';
import {
  clampDrag,
  dropIndex,
  moveItem,
  moveWithin,
  shiftFor,
} from '@/components/pages/create/reorder';
import {
  failedFilesLine,
  failedUploadCount,
  insertBySeq,
  slideCounterText,
  slideFromScroll,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';
import {
  CAPTION_LIMITS,
  captionCounterText,
  captionOverLimit,
  groupDigits,
} from '@/components/pages/create/caption-limits';
import {
  BUCKET_SAVE_FAILED,
  createSheetErrorMessage,
  POST_SAVE_FAILED,
} from '@/components/pages/create/errors';
import { RemoveButton } from '@/components/pages/create/RemoveButton';
import { plainError } from '@/lib/error-copy';

/** Let promise chains (then/finally) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('Post flow A helpers', () => {
  it('fix 11: the first file sets the format per platform', () => {
    expect(formatForFile('instagram', FORMATS_BY_PLATFORM.instagram, 'image')).toBe('single_image');
    expect(formatForFile('instagram', FORMATS_BY_PLATFORM.instagram, 'video')).toBe('reel');
    expect(formatForFile('tiktok', FORMATS_BY_PLATFORM.tiktok, 'video')).toBe('video');
    expect(formatForFile('facebook', FORMATS_BY_PLATFORM.facebook, 'video')).toBe('video');
    expect(formatForFile('x', FORMATS_BY_PLATFORM.x, 'image')).toBe('single_image');
    // No single-kind format for the file, or not a photo or video: keep the current one.
    expect(formatForFile('tiktok', FORMATS_BY_PLATFORM.tiktok, 'image')).toBeNull();
    expect(formatForFile('instagram', FORMATS_BY_PLATFORM.instagram, 'document')).toBeNull();
  });

  it('fix 11: before any file Instagram opens on Single image, others on their first format', () => {
    expect(untouchedDefaultFormat('instagram', FORMATS_BY_PLATFORM.instagram)).toBe('single_image');
    expect(untouchedDefaultFormat('linkedin', FORMATS_BY_PLATFORM.linkedin)).toBe('text');
    expect(untouchedDefaultFormat('tiktok', FORMATS_BY_PLATFORM.tiktok)).toBe('video');
    expect(untouchedDefaultFormat('youtube_shorts', FORMATS_BY_PLATFORM.youtube_shorts)).toBe(
      'short',
    );
  });

  it('fix 12: createLimiter(3) never runs more than 3 jobs and starts queued jobs in order', async () => {
    expect(UPLOAD_CONCURRENCY).toBe(3);
    const limiter = createLimiter(3);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const finish: (() => void)[] = [];
    const runs = [0, 1, 2, 3, 4].map((n) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            started.push(n);
            finish[n] = () => {
              active -= 1;
              resolve(n);
            };
          }),
      ),
    );
    expect(started).toEqual([0, 1, 2]);
    finish[1]?.();
    await runs[1];
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    finish[0]?.();
    await runs[0];
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    for (const n of [2, 3, 4]) finish[n]?.();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(3);
  });

  it('fix 12: a failed job frees its slot and rejects only its own promise', async () => {
    const limiter = createLimiter(1);
    const second = vi.fn(async () => 'ok');
    const first = limiter.run(async () => {
      throw new Error('nope');
    });
    const next = limiter.run(second);
    await expect(first).rejects.toThrow('nope');
    await expect(next).resolves.toBe('ok');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fix 13: reorder helpers', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    // Only the media move; the link and the file keep their slots.
    const items = ['m1', 'link', 'm2', 'file', 'm3'];
    expect(moveWithin(items, (x) => x.startsWith('m'), 0, 2)).toEqual([
      'm2',
      'link',
      'm3',
      'file',
      'm1',
    ]);
    expect(dropIndex(0, 72, 72, 3)).toBe(1);
    expect(dropIndex(0, 30, 72, 3)).toBe(0);
    expect(dropIndex(1, -500, 72, 3)).toBe(0);
    expect(dropIndex(1, 500, 72, 3)).toBe(2);
    expect(dropIndex(1, 72, 0, 3)).toBe(1);
    expect(clampDrag(1, -500, 72, 3)).toBe(-72);
    expect(clampDrag(1, 500, 72, 3)).toBe(72);
    expect(clampDrag(1, 20, 72, 3)).toBe(20);
    // Dragging 0 to 2: tiles 1 and 2 shift left one slot; others stay.
    expect(shiftFor(0, 0, 2, 72)).toBe(0);
    expect(shiftFor(1, 0, 2, 72)).toBe(-72);
    expect(shiftFor(2, 0, 2, 72)).toBe(-72);
    expect(shiftFor(3, 0, 2, 72)).toBe(0);
    // Dragging 2 to 0: tiles 0 and 1 shift right.
    expect(shiftFor(0, 2, 0, 72)).toBe(72);
    expect(shiftFor(1, 2, 0, 72)).toBe(72);
  });

  it('fix 13: slide counter, slide from scroll, and insert at picked place', () => {
    expect(slideCounterText(0, 3)).toBe('1/3');
    expect(slideCounterText(2, 3)).toBe('3/3');
    expect(slideFromScroll(0, 300, 3)).toBe(0);
    expect(slideFromScroll(310, 300, 3)).toBe(1);
    expect(slideFromScroll(5000, 300, 3)).toBe(2);
    expect(slideFromScroll(100, 0, 3)).toBe(0);
    const a: AttachmentItem = { versionId: 'a', kind: 'image', name: 'a' };
    const b: AttachmentItem = { versionId: 'b', kind: 'image', name: 'b' };
    const c: AttachmentItem = { versionId: 'c', kind: 'image', name: 'c' };
    const seqs = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const seqOf = (item: AttachmentItem): number | undefined => seqs.get(item.versionId);
    // b finished last but was picked between a and c.
    expect(insertBySeq([a, c], b, 2, seqOf).map((i) => i.versionId)).toEqual(['a', 'b', 'c']);
    expect(insertBySeq([a, b], c, 3, seqOf).map((i) => i.versionId)).toEqual(['a', 'b', 'c']);
  });

  it('fix 14: failed files count and the "didn\'t upload" line', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(
      failedUploadCount([
        { error: 'x', file },
        { error: null, file },
        // A failed link is not a file.
        { error: 'x' },
        { error: 'y', file },
      ]),
    ).toBe(2);
    expect(failedFilesLine(1)).toBe("1 file didn't upload.");
    expect(failedFilesLine(3)).toBe("3 files didn't upload.");
  });

  it('fix 15: caption limits, Indian digit grouping and the over-limit flag', () => {
    expect(CAPTION_LIMITS).toEqual({
      instagram: 2200,
      linkedin: 3000,
      x: 280,
      threads: 500,
      facebook: 63206,
      tiktok: 4000,
      youtube_shorts: 5000,
    });
    expect(groupDigits(100000)).toBe('100,000');
    expect(groupDigits(1000000)).toBe('1,000,000');
    expect(groupDigits(63206)).toBe('63,206');
    expect(captionCounterText(12, 2200)).toBe('12 / 2,200');
    expect(captionCounterText(100000, 63206)).toBe('100,000 / 63,206');
    expect(captionOverLimit(280, 280)).toBe(false);
    expect(captionOverLimit(281, 280)).toBe(true);
  });

  it('fix 41: save errors are plain words, never the raw server text', () => {
    expect(POST_SAVE_FAILED).toBe("Couldn't save the post. Try again.");
    expect(createSheetErrorMessage('duplicate key value violates "posts_pkey"', 'x')).toBe(
      POST_SAVE_FAILED,
    );
    expect(createSheetErrorMessage('invalid_format', 'tiktok')).toBe(
      'That format is not available on TikTok.',
    );
    expect(createSheetErrorMessage('invalid_format', null)).toBe(
      'That format is not available here.',
    );
    expect(createSheetErrorMessage('forbidden_role', 'instagram')).toBe(
      plainError('forbidden_role'),
    );
    expect(createSheetErrorMessage('forbidden_role', 'instagram')).toBe(
      "You don't have permission to do that.",
    );
    expect(createSheetErrorMessage('boom', 'x', BUCKET_SAVE_FAILED)).toBe(
      "Couldn't create the bucket. Try again.",
    );
  });

  it('extra: RemoveButton keeps a 44x44 tap area with a small 20px visible circle', () => {
    const onRemove = vi.fn();
    const el = RemoveButton({ label: 'Remove a.png', onRemove }) as ReactElement<{
      className: string;
      'aria-label': string;
      onClick: () => void;
      children: ReactElement<{ className: string }>;
    }>;
    expect(el.props.className).toContain('h-11');
    expect(el.props.className).toContain('w-11');
    expect(el.props['aria-label']).toBe('Remove a.png');
    expect(el.props.children.props.className).toContain('h-5');
    expect(el.props.children.props.className).toContain('w-5');
    el.props.onClick();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
