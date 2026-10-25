import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// The unit environment is node (no DOM/clipboard), so these specs exercise the
// pure link-decision helper that handleCopyLink delegates to: it is what decides
// between the pretty short link and the classic long link and is what the Copy
// link action ultimately writes to the clipboard. Importing the component module
// transitively loads a browser-only chat dependency that reads `self` at eval
// time, so we stub that global and pull the helper in via a dynamic import once
// the stub is in place.

let postCopyLink: (
  origin: string,
  workspaceKey: string | null,
  postNumber: number,
  postId: string,
) => string;

let postActionLabels: (opts: {
  openInPipeline: boolean;
  download: boolean;
  canDelete: boolean;
  removeImage?: boolean;
}) => string[];

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = globalThis;
  ({ postCopyLink, postActionLabels } = await import('@/components/pages/pcs/PostActionSheet'));
});

describe('postCopyLink', () => {
  it('builds the pretty /p/<key>-<number> short link when the workspace key is known', () => {
    expect(postCopyLink('https://app.example', 'GBL', 142, 'uuid-1')).toBe(
      'https://app.example/p/gbl-142',
    );
  });

  it('lowercases the workspace key and drops leading zeros in the short link', () => {
    expect(postCopyLink('https://app.example', 'Abc', 7, 'uuid-1')).toBe(
      'https://app.example/p/abc-7',
    );
  });

  it('falls back to the classic /posts/<uuid> long link when the workspace key is null', () => {
    expect(postCopyLink('https://app.example', null, 142, 'uuid-1')).toBe(
      'https://app.example/posts/uuid-1',
    );
  });

  it('uses the caller origin verbatim and never hardcodes a domain', () => {
    expect(postCopyLink('https://staging.internal', 'KEY', 3, 'uuid-2')).toBe(
      'https://staging.internal/p/key-3',
    );
    expect(postCopyLink('http://localhost:5173', null, 3, 'uuid-2')).toBe(
      'http://localhost:5173/posts/uuid-2',
    );
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(postCopyLink('https://app.example/', 'GBL', 142, 'uuid-1')).toBe(
      'https://app.example/p/gbl-142',
    );
  });
});

describe('post actions (W9)', () => {
  it('Open in pipeline leads when offered, Copy link next; Delete is last and agency only', () => {
    expect(postActionLabels({ openInPipeline: true, download: true, canDelete: true })).toEqual([
      'Open in pipeline',
      'Copy link',
      'Send to chat',
      'Download all images',
      'Delete post',
    ]);
    expect(postActionLabels({ openInPipeline: true, download: false, canDelete: false })).toEqual([
      'Open in pipeline',
      'Copy link',
      'Send to chat',
    ]);
    expect(postActionLabels({ openInPipeline: false, download: false, canDelete: true })).toEqual([
      'Copy link',
      'Send to chat',
      'Delete post',
    ]);
  });

  it('Remove image (moved from the picture ⋮) sits just before Delete post', () => {
    expect(
      postActionLabels({
        openInPipeline: false,
        download: true,
        canDelete: true,
        removeImage: true,
      }),
    ).toEqual(['Copy link', 'Send to chat', 'Download all images', 'Remove image', 'Delete post']);
  });

  it('the menu is ui/ActionMenu, with no IconMore of its own', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostActionSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('<ActionMenu');
    expect(src).not.toContain('IconMore');
    expect(src).not.toContain('ActionRow');
  });
});

describe('Delete post and Remove image have no confirm (spec B7, PR B delete rule)', () => {
  it('no confirm view, no plans read; the rows hand off to the page at once', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostActionSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('confirm-delete');
    expect(src).not.toContain('readPostPlans(');
    expect(src).not.toContain('removeImageConfirmCopy');
    expect(src).toContain('onDelete: canDelete ? () => void onDeletePost() : null');
  });
});
