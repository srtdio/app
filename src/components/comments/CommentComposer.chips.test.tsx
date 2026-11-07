import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FileUploadChip,
  LibraryPickChip,
  uploadChipMeta,
  uploadChipStatus,
  type Pending,
} from '@/components/comments/CommentComposer';
import type { LibraryAsset } from '@/lib/chat/asset-picker';

// Decision F: one pending-file chip. The comment composers (CommentComposer,
// SlotComposer) and ConceptSheet render ui/PendingChip through these.

const MB = 1024 * 1024;
const pdf = new File([new Uint8Array(Math.round(1.2 * MB))], 'deck.pdf', {
  type: 'application/pdf',
});

function chip(item: Pick<Pending, 'file' | 'previewUrl' | 'status' | 'retryable'>): string {
  return renderToStaticMarkup(
    <ul>
      <FileUploadChip item={item} onRemove={() => {}} onRetry={() => {}} />
    </ul>,
  );
}

describe('uploadChipStatus / uploadChipMeta', () => {
  it('maps the upload lifecycle onto the chip states (no bytes: progress null)', () => {
    expect(uploadChipStatus({ state: 'uploading' })).toEqual({ state: 'uploading', progress: null });
    expect(uploadChipStatus({ state: 'done', versionId: 'v1' })).toEqual({ state: 'ready' });
    expect(uploadChipStatus({ state: 'error', message: 'x' })).toEqual({ state: 'failed' });
  });

  it('uploading reads the size total; ready reads "<TYPE> · <size>"', () => {
    expect(uploadChipMeta({ file: pdf, status: { state: 'uploading' } })).toBe('1.2 MB');
    expect(uploadChipMeta({ file: pdf, status: { state: 'done', versionId: 'v1' } })).toBe(
      'PDF · 1.2 MB',
    );
  });
});

describe('FileUploadChip', () => {
  it('uploading: the ring on the thumb, size meta, no trailing remove, no % text', () => {
    const html = chip({ file: pdf, previewUrl: null, status: { state: 'uploading' } });
    expect(html).toContain('data-pending-chip="uploading"');
    expect(html).toContain('data-upload-ring');
    expect(html).toContain('aria-label="Cancel upload"');
    expect(html).toContain('1.2 MB');
    expect(html).not.toContain('aria-label="Remove deck.pdf"');
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/%/);
  });

  it('ready: "PDF · 1.2 MB" and the trailing remove', () => {
    const html = chip({ file: pdf, previewUrl: null, status: { state: 'done', versionId: 'v1' } });
    expect(html).toContain('data-pending-chip="ready"');
    expect(html).toContain('PDF · 1.2 MB');
    expect(html).toContain('aria-label="Remove deck.pdf"');
    expect(html).not.toContain('data-upload-ring');
  });

  it('failed: Retry when retryable, none after a failed pre-check', () => {
    const failed = chip({ file: pdf, previewUrl: null, status: { state: 'error', message: 'x' } });
    expect(failed).toContain('data-pending-chip="failed"');
    expect(failed).toContain('aria-label="Retry deck.pdf"');
    expect(failed).toContain('aria-label="Remove deck.pdf"');
    const precheck = chip({
      file: pdf,
      previewUrl: null,
      status: { state: 'error', message: 'Too big' },
      retryable: false,
    });
    expect(precheck).not.toContain('aria-label="Retry deck.pdf"');
  });

  it('a picked photo shows its own picture as the thumb', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const html = chip({ file: png, previewUrl: 'blob:a', status: { state: 'uploading' } });
    expect(html).toContain('src="blob:a"');
  });

  it('the caller\'s data hooks land on the chip', () => {
    const onRemove = vi.fn();
    const html = renderToStaticMarkup(
      <ul>
        <FileUploadChip
          item={{ file: pdf, previewUrl: null, status: { state: 'uploading' } }}
          onRemove={onRemove}
          dataAttrs={{ 'data-plan-concept-upload': 'uploading' }}
        />
      </ul>,
    );
    expect(html).toMatch(/<li[^>]*data-plan-concept-upload="uploading"/);
  });
});

describe('LibraryPickChip', () => {
  it('a library pick is ready from the start: "<TYPE> · <size>" from its version', () => {
    const asset: LibraryAsset = {
      assetId: 'a1',
      versionId: 'v-lib',
      name: 'Brand guide',
      filename: 'brand-guide.pdf',
      uploadedAt: '2026-11-01T10:00:00Z',
      version: {
        id: 'v-lib',
        mime_type: 'application/pdf',
        size_bytes: 3 * MB,
        duration_ms: null,
        width: null,
        height: null,
        kind: 'document',
      },
    };
    const html = renderToStaticMarkup(
      <ul>
        <LibraryPickChip asset={asset} onRemove={() => {}} />
      </ul>,
    );
    expect(html).toContain('data-library-chip="v-lib"');
    expect(html).toContain('data-pending-chip="ready"');
    expect(html).toContain('PDF · 3 MB');
    expect(html).toContain('aria-label="Remove Brand guide"');
  });
});
