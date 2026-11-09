import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canRetryPending } from '@/components/comments/CommentComposer';

// FT17: a failed comment attachment chip gets Retry, as AttachmentsField has.
const SRC = readFileSync(fileURLToPath(new URL('./CommentComposer.tsx', import.meta.url)), 'utf8');

describe('comment attachment Retry (FT17)', () => {
  it('offers Retry for a failed upload, not for a pre-check failure or a live upload', () => {
    expect(canRetryPending({ status: { state: 'error', message: 'Upload failed' } })).toBe(true);
    expect(
      canRetryPending({ status: { state: 'error', message: 'Too big' }, retryable: false }),
    ).toBe(false);
    expect(canRetryPending({ status: { state: 'uploading' } })).toBe(false);
    expect(canRetryPending({ status: { state: 'done', versionId: 'v1' } })).toBe(false);
  });

  it('the chip (ui/PendingChip) gets Retry wired to the composer, and the pre-check branch opts out', () => {
    expect(SRC).toContain(
      'onRetry={onRetry !== undefined && canRetryPending(item) ? onRetry : undefined}',
    );
    // The upload flow is the shared useCommentUploads hook (the catch-up reply uses it too).
    expect(SRC).toContain('onRetry={() => uploads.retryPending(item.id)}');
    expect(SRC).toContain('retryable: false,');
    // Retry re-runs the same upload path the first attempt used.
    expect(SRC).toContain('void uploadPending(id, target.file);');
  });
});
