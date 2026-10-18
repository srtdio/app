// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPostCreate, mockCreateBucket, captured } = vi.hoisted(() => ({
  mockPostCreate: vi.fn(),
  mockCreateBucket: vi.fn(),
  captured: { onPendingChange: null as ((n: number) => void) | null },
}));

vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) => (id === 'ws-1' ? 'instagram' : null),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceName: 'Kite' }) }));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({
  BUCKET_NAME_MAX: 40,
  listBuckets: async () => ({ ok: true, data: [] }),
  createBucket: mockCreateBucket,
}));
vi.mock('@srtdio/briefs', () => ({ listBriefs: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: (props: { onPendingChange?: (n: number) => void }) => {
    captured.onPendingChange = props.onPendingChange ?? null;
    return <span data-attachments="" />;
  },
  isMediaItem: () => false,
  attachmentVersionIds: () => [],
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({ postCreate: mockPostCreate, gallerySet: vi.fn() }));

import {
  CreatePostSheet,
  createPostDirty,
  resolvedTitle,
  uploadingLabel,
} from '@/components/pages/CreatePostSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockPostCreate.mockReset();
  mockCreateBucket.mockReset();
  captured.onPendingChange = null;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
  delete (window as { matchMedia?: unknown }).matchMedia;
});

async function renderSheet(): Promise<void> {
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <CreatePostSheet open workspaceId="ws-1" onClose={() => {}} onCreated={() => {}} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const el = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (el === undefined) throw new Error(`no button ${text}`);
  return el;
}

const caption = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>('#post-caption')!;

describe('CreatePostSheet W1', () => {
  it('fix 1: closing with a caption asks "Discard this post?"', async () => {
    expect(
      createPostDirty(
        { title: '', caption: '', bucketId: '', targetDate: '', briefId: '', attachments: [] },
        0,
      ),
    ).toBe(false);
    expect(
      createPostDirty(
        { title: '', caption: '', bucketId: '', targetDate: '', briefId: '', attachments: [] },
        1,
      ),
    ).toBe(true);
    await renderSheet();
    await act(async () => setValue(caption(), 'Hello'));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    );
    expect(document.body.textContent).toContain('Discard this post?');
    expect(document.body.textContent).toContain('Your caption and files will be lost.');
    expect(document.body.textContent).toContain('Keep editing');
  });

  it('fix 2: mid-upload the primary says "Uploading N files…", stays enabled, and refuses to submit', async () => {
    expect(uploadingLabel(1)).toBe('Uploading 1 file…');
    await renderSheet();
    await act(async () => setValue(caption(), 'Hello'));
    await act(async () => captured.onPendingChange?.(3));
    const primary = button('Uploading 3 files…');
    expect(primary.disabled).toBe(false);
    await act(async () => primary.click());
    expect(document.body.textContent).toContain('Wait for 3 files to finish');
    expect(mockPostCreate).not.toHaveBeenCalled();
  });

  it('fix 3: an empty form keeps Save enabled and shows the inline required error', async () => {
    await renderSheet();
    const save = button('Save as draft');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(document.body.textContent).toContain('Write a caption');
    expect(mockPostCreate).not.toHaveBeenCalled();
  });

  it('fix 4: fields run Format, Media, Caption, Title, Bucket, Target date, Brief; an empty title uses the caption', async () => {
    expect(resolvedTitle('', 'First line\nsecond')).toBe('First line');
    await renderSheet();
    const labels = [...document.querySelectorAll('label')].map((l) =>
      (l.textContent ?? '').replace('*', '').trim(),
    );
    expect(labels).toEqual([
      'Format',
      'Media',
      'Caption',
      'Title (optional)',
      'Bucket (optional)',
      'Target date (optional)',
      'Brief (optional)',
    ]);
    mockPostCreate.mockResolvedValue({ ok: true, data: 'p1' });
    await act(async () => setValue(caption(), 'Launch day\nMore words'));
    await act(async () => button('Save as draft').click());
    const args = mockPostCreate.mock.calls[0]![1] as { p_payload: Record<string, unknown> };
    expect(args.p_payload).toMatchObject({ title: 'Launch day' });
  });

  it('fix 5: "+ New bucket" creates inline, selects it, and words errors', async () => {
    await renderSheet();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Bucket"]')!.click(),
    );
    const opt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === '+ New bucket',
    );
    await act(async () => opt!.click());
    const name = document.querySelector<HTMLInputElement>('input[aria-label="New bucket name"]')!;
    mockCreateBucket.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: "That name's already taken." },
    });
    await act(async () => setValue(name, 'Launch'));
    await act(async () => button('Create').click());
    expect(document.body.textContent).toContain("That name's already taken.");
    mockCreateBucket.mockResolvedValueOnce({
      ok: true,
      data: { id: 'b9', name: 'Launch', colorHex: '#123456', position: 0 },
    });
    await act(async () => button('Create').click());
    expect(mockCreateBucket).toHaveBeenLastCalledWith({}, 'ws-1', 'Launch', 'trace-1');
    expect(document.querySelector('input[aria-label="New bucket name"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Bucket"]')?.textContent).toContain('Launch');
  });

  it('fix 6: desktop focuses Caption on open; touch does not autofocus', async () => {
    await renderSheet();
    expect(document.activeElement).toBe(caption());
    act(() => root?.unmount());
    root = null;
    window.matchMedia = ((q: string) => ({
      matches: q === '(pointer: coarse)',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as never;
    await renderSheet();
    expect(document.activeElement).not.toBe(caption());
  });
});
