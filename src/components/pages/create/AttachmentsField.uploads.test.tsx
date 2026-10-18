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
    let release: (() => void) | null = null;
    mockUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, message: "Couldn't upload. Try again." });
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

    await act(async () => release?.());
    expect(onPendingChange).toHaveBeenLastCalledWith(2);
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry a.png"]');
    expect(retry).not.toBeNull();
    expect(retry!.className).toContain('h-11');
    expect(document.querySelector('button[aria-label="Dismiss a.png"]')).not.toBeNull();

    mockUpload.mockClear();
    await act(async () => retry!.click());
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith(3);
  });
});
