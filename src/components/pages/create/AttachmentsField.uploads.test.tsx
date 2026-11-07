// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
}));
vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_UPLOAD_URL: 'https://upload.test' } }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/attachments', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/attachments')>()),
  precheckImage: () => ({ ok: true }),
  uploadChatAttachment: mockUpload,
}));

import { AttachmentsField, pendingUploadCount } from './AttachmentsField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockUpload.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function photoInput(): HTMLInputElement {
  const el = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')][0];
  if (el === undefined) throw new Error('no photo input');
  return el;
}

function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AttachmentsField uploads', () => {
  it('counts only rows still uploading', () => {
    expect(pendingUploadCount([{ error: null }, { error: 'x' }, { error: null }])).toBe(2);
  });

  it('photo and document inputs accept multiple files', async () => {
    await act(async () => {
      root!.render(<AttachmentsField workspaceId="ws-1" value={[]} onChange={() => {}} />);
    });
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs[0]?.multiple).toBe(true);
    expect(inputs[2]?.multiple).toBe(true);
  });

  it('reports the pending count for every picked file, and a failed row retries', async () => {
    // Up to three upload at once: each call parks until the test releases it.
    const releases: (() => void)[] = [];
    mockUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: false, message: "Couldn't upload. Try again." }));
        }),
    );
    const onPendingChange = vi.fn();
    await act(async () => {
      root!.render(
        <AttachmentsField
          workspaceId="ws-1"
          value={[]}
          onChange={() => {}}
          onPendingChange={onPendingChange}
        />,
      );
    });
    const files = ['a.png', 'b.png', 'c.png'].map((n) => new File(['x'], n, { type: 'image/png' }));
    await act(async () => pick(photoInput(), files));
    expect(onPendingChange).toHaveBeenLastCalledWith(3);

    expect(mockUpload).toHaveBeenCalledTimes(3);
    // The first picked file (a.png) fails; b and c are still uploading.
    await act(async () => releases[0]?.());
    expect(onPendingChange).toHaveBeenLastCalledWith(2);
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry a.png"]');
    expect(retry).not.toBeNull();
    expect(retry!.className).toContain('h-11');
    // ui/PendingChip failed state: Retry plus the trailing X that removes it.
    expect(document.querySelector('button[aria-label="Remove a.png"]')).not.toBeNull();
    expect(document.querySelector('[data-pending-chip="failed"]')).not.toBeNull();
    // b and c upload as PendingChip with the ring (X cancels), never a bar or "Uploading" text.
    expect(
      document.querySelectorAll('[data-pending-chip="uploading"] [data-upload-ring]').length,
    ).toBe(2);
    expect(document.body.textContent).not.toMatch(/Uploading|\d%/);

    mockUpload.mockClear();
    await act(async () => retry!.click());
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith(3);
  });
});

describe('pendingChipMeta', () => {
  it('size progress from bytes for a file, "Link" for a link, never a % figure', async () => {
    const { pendingChipMeta } = await import('@/components/pages/create/AttachmentsField');
    const MB = 1024 * 1024;
    const file = new File([new Uint8Array(2 * MB)], 'deck.pdf');
    expect(pendingChipMeta({ kind: 'file', file, progress: 0.5 })).toBe('1.0 of 2.0 MB');
    expect(pendingChipMeta({ kind: 'link', progress: 0 })).toBe('Link');
    expect(pendingChipMeta({ kind: 'file', file, progress: 0 })).not.toMatch(/%/);
  });
});
