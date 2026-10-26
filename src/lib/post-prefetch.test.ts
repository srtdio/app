import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

// A card press starts the post, gallery, role and members reads and the page
// chunks; the open's mount joins the post and gallery reads (one request
// each). Only a press confirmed by the card's click is joined, and only once.

const h = vi.hoisted(() => ({
  getPost: 0,
  getPostGallery: 0,
  role: 0,
  members: 0,
}));

vi.mock('@srtdio/posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/posts')>()),
  getPost: async () => {
    h.getPost += 1;
    return { ok: true, data: null };
  },
  getPostGallery: async () => {
    h.getPostGallery += 1;
    return { ok: true, data: [] };
  },
}));
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: async () => {
    h.role += 1;
    return { ok: true, role: 'agency' };
  },
}));
vi.mock('@/lib/workspace-members', () => ({
  ensureWorkspaceMembers: () => {
    h.members += 1;
  },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  confirmPostOpen,
  prefetchPostOpen,
  POST_OPEN_FRESH_MS,
  PRESS_DEDUPE_MS,
  resetPostOpen,
  takePostDetail,
  takePostGallery,
  type PostOpenDeps,
} from '@/lib/post-prefetch';
import { resetSessionReads } from '@/lib/session-read';

const client = {} as unknown as Client;
let clock = 1_000_000;
const chunk = vi.fn(() => Promise.resolve());
const deps = (): PostOpenDeps => ({
  context: () => ({ userId: 'u1', workspaceId: 'w1' }),
  client,
  loaders: [chunk],
  now: () => clock,
});

async function mountReads(): Promise<void> {
  await Promise.all([
    takePostDetail(client, 'u1', 'w1', 'p1', clock),
    takePostGallery(client, 'u1', 'w1', 'p1', clock),
  ]);
}

beforeEach(() => {
  h.getPost = 0;
  h.getPostGallery = 0;
  h.role = 0;
  h.members = 0;
  chunk.mockClear();
  clock = 1_000_000;
});

afterEach(() => {
  resetPostOpen();
  resetSessionReads();
});

describe('post card press prefetch', () => {
  it('starts the chunk and every first-paint read on the press, before any click', () => {
    prefetchPostOpen('p1', deps());
    expect(chunk).toHaveBeenCalledTimes(1);
    expect(h.getPost).toBe(1);
    expect(h.getPostGallery).toBe(1);
    expect(h.role).toBe(1);
    expect(h.members).toBe(1);
  });

  it('a confirmed press is joined by the mount: one read each in all', async () => {
    prefetchPostOpen('p1', deps());
    // pointerdown and touchstart of the same tap: still one read each.
    prefetchPostOpen('p1', deps());
    confirmPostOpen('p1', deps());
    await mountReads();
    expect(h.getPost).toBe(1);
    expect(h.getPostGallery).toBe(1);
  });

  it('is single use: a later open of the same post reads again', async () => {
    prefetchPostOpen('p1', deps());
    confirmPostOpen('p1', deps());
    await mountReads();
    await mountReads();
    expect(h.getPost).toBe(2);
    expect(h.getPostGallery).toBe(2);
  });

  it('never serves a press that did not become an open (a drag, a menu move)', async () => {
    prefetchPostOpen('p1', deps());
    await Promise.resolve();
    // No click: the mount (a later open by another path) reads fresh.
    await mountReads();
    expect(h.getPost).toBe(2);
    expect(h.getPostGallery).toBe(2);
  });

  it('a new press after the dedupe window drops the earlier press reads', async () => {
    prefetchPostOpen('p1', deps());
    clock += PRESS_DEDUPE_MS + 1;
    prefetchPostOpen('p1', deps());
    expect(h.getPost).toBe(2);
    confirmPostOpen('p1', deps());
    await mountReads();
    // The mount joined the second press: no third read.
    expect(h.getPost).toBe(2);
  });

  it('a confirmation older than the freshness window is not joined', async () => {
    prefetchPostOpen('p1', deps());
    confirmPostOpen('p1', deps());
    clock += POST_OPEN_FRESH_MS + 1;
    await mountReads();
    expect(h.getPost).toBe(2);
  });

  it('does nothing before the shell knows the viewer and workspace', () => {
    prefetchPostOpen('p1', { ...deps(), context: () => null });
    expect(chunk).not.toHaveBeenCalled();
    expect(h.getPost).toBe(0);
  });
});
