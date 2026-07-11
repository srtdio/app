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

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = globalThis;
  ({ postCopyLink } = await import('@/components/pages/pcs/PostActionSheet'));
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
