// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostPlatform } from '@srtdio/posts';

const { mockWorkspace, mockPostCreate } = vi.hoisted(() => ({
  mockWorkspace: { workspacePlatform: 'instagram' as PostPlatform },
  mockPostCreate: vi.fn(),
}));

// The sheet reads the platform of the workspace it was opened on.
vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) =>
    id === 'ws-1' ? mockWorkspace.workspacePlatform : null,
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({ listBuckets: async () => ({ ok: true, data: [] }) }));
vi.mock('@srtdio/briefs', () => ({ listBriefs: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({ options: [] }),
}));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: () => null,
  attachmentVersionIds: () => [],
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({ postCreate: mockPostCreate, gallerySet: vi.fn() }));

import { CreatePostSheet } from '@/components/pages/CreatePostSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockPostCreate.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function renderSheet(platform: PostPlatform): Promise<void> {
  mockWorkspace.workspacePlatform = platform;
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <CreatePostSheet open workspaceId="ws-1" onClose={() => {}} onCreated={() => {}} />,
    );
  });
}

function formatTrigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button[aria-label="Format"]');
  if (el === null) throw new Error('no Format select');
  return el;
}

async function openFormats(): Promise<string[]> {
  await act(async () => formatTrigger().click());
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CreatePostSheet', () => {
  it('has no Platform select', async () => {
    await renderSheet('instagram');
    expect(document.querySelector('button[aria-label="Platform"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Choose a platform');
  });

  it("lists only the workspace platform's formats and defaults to the first", async () => {
    await renderSheet('instagram');
    expect(formatTrigger().textContent).toContain('Reel');
    expect(await openFormats()).toEqual(['Reel', 'Story', 'Carousel', 'Single image']);
  });

  it.each([
    ['x', ['Text', 'Image', 'Video', 'Thread']],
    ['tiktok', ['Video']],
    ['youtube_shorts', ['Short']],
    ['linkedin', ['Text', 'Single image', 'Carousel', 'Video', 'Link']],
  ] as const)('on %s offers %j', async (platform, labels) => {
    await renderSheet(platform);
    expect(await openFormats()).toEqual(labels);
  });

  it('sends no platform to post_create and words invalid_format', async () => {
    mockPostCreate.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'invalid_format' },
    });
    await renderSheet('tiktok');
    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>('#post-title')!, 'Launch');
      setValue(document.querySelector<HTMLTextAreaElement>('#post-caption')!, 'Caption');
    });
    const save = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save as draft',
    );
    await act(async () => save!.click());

    expect(mockPostCreate).toHaveBeenCalledTimes(1);
    const args = mockPostCreate.mock.calls[0]![1] as { p_payload: Record<string, unknown> };
    expect(args.p_payload).toMatchObject({ title: 'Launch', format: 'video' });
    expect('platform' in args.p_payload).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'That format is not available on TikTok.',
    );
  });
});
