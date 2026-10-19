import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@srtdio/rpc';
import type { PostPlanRef } from '@/lib/chat/plans';

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

let deleteConfirmText: (plans: Result<PostPlanRef[]> | null) => string;
let postActionLabels: (opts: {
  openInPipeline: boolean;
  download: boolean;
  canDelete: boolean;
}) => string[];

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = globalThis;
  ({ postCopyLink, deleteConfirmText, postActionLabels } =
    await import('@/components/pages/pcs/PostActionSheet'));
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
  it('Open in pipeline leads when offered; Delete is last and agency only', () => {
    expect(postActionLabels({ openInPipeline: true, download: true, canDelete: true })).toEqual([
      'Open in pipeline',
      'Send to chat',
      'Copy link',
      'Download all images',
      'Delete post',
    ]);
    expect(postActionLabels({ openInPipeline: true, download: false, canDelete: false })).toEqual([
      'Open in pipeline',
      'Send to chat',
      'Copy link',
    ]);
    expect(postActionLabels({ openInPipeline: false, download: false, canDelete: true })).toEqual([
      'Send to chat',
      'Copy link',
      'Delete post',
    ]);
  });

  it('the sheet renders Open in pipeline first, only when the host passes it', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostActionSheet.tsx', import.meta.url)),
      'utf8',
    );
    const rows = src.slice(src.indexOf('<div className="flex flex-col gap-1">'));
    expect(rows.indexOf('label="Open in pipeline"')).toBeLessThan(
      rows.indexOf('label="Send to chat"'),
    );
    expect(rows).toContain('{onOpenInPipeline !== undefined ? (');
    expect(rows).toContain('{canDelete ? (');
  });
});

describe('delete confirm names the plans (W10)', () => {
  const plan = (title: string): PostPlanRef => ({ planId: title, title });
  it('0 / 1 / 2+ plans, and the base copy while reading or on failure', () => {
    const base = 'Delete this post? Moves to Recently deleted.';
    expect(deleteConfirmText(null)).toBe(base);
    expect(deleteConfirmText({ ok: true, data: [] })).toBe(base);
    expect(deleteConfirmText({ ok: true, data: [plan('Week 42')] })).toBe(
      `${base} It's in Week 42 and will leave that plan.`,
    );
    expect(deleteConfirmText({ ok: true, data: [plan('Week 42'), plan('B'), plan('C')] })).toBe(
      `${base} It's in Week 42 and 2 other plans and will leave them.`,
    );
    expect(
      deleteConfirmText({ ok: false, error: { code: 'unknown', message: 'read timed out' } }),
    ).toBe(base);
  });

  it('reads once per confirm opening (no per-plan reads)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostActionSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(src.match(/readPostPlans\(/g)).toHaveLength(1);
    expect(src).toContain("const confirming = open && view === 'confirm-delete';");
    expect(src).toContain('}, [confirming, postId]);');
  });
});
