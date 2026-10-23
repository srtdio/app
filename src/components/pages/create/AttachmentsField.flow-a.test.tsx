// @vitest-environment jsdom
// Post flow A: the framed create sheet's file tiles (parallel uploads, progress,
// the failed-files bar) and the failed link row's Retry.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpload, mockAddLink } = vi.hoisted(() => ({
  mockUpload: vi.fn(),
  mockAddLink: vi.fn(),
}));

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
vi.mock('@/lib/asset-upload', async (orig) => ({
  ...(await orig<typeof import('@/lib/asset-upload')>()),
  precheckFile: () => ({ ok: true }),
  addAssetLink: mockAddLink,
}));

import { UPLOAD_ACCEPT } from '@/lib/asset-upload';
import { AttachmentsField } from './AttachmentsField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockUpload.mockReset();
  mockAddLink.mockReset();
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

const FRAME = { platform: 'instagram', format: 'single_image' };

function mediaInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    'input[type="file"][aria-label="Add a photo or video"]',
  );
  if (el === null) throw new Error('no media input');
  return el;
}

function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function photos(...names: string[]): File[] {
  return names.map((n) => new File(['x'], n, { type: 'image/png' }));
}

function setValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
}

function buttonsByText(text: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => (b.textContent ?? '').trim() === text,
  );
}

describe('AttachmentsField flow A (framed)', () => {
  it('fix 12: up to 3 upload at once, pending tiles show progress, and the empty frame is disabled meanwhile', async () => {
    mockUpload.mockImplementation(() => new Promise(() => {}));
    const onPendingChange = vi.fn();
    await act(async () => {
      root!.render(
        <AttachmentsField
          workspaceId="ws-1"
          value={[]}
          onChange={() => {}}
          frame={FRAME}
          onPendingChange={onPendingChange}
        />,
      );
    });
    const empty = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>('[data-frame-empty] button');
    expect(empty()?.disabled).toBe(false);

    await act(async () => pick(mediaInput(), photos('a.png', 'b.png', 'c.png', 'd.png')));
    expect(mockUpload).toHaveBeenCalledTimes(3);
    // Every upload goes over XHR with a trace id and a progress callback.
    const params = mockUpload.mock.calls[0]![0] as {
      origin: string;
      xhr: { traceId: string; onProgress: (n: number) => void };
    };
    expect(params.origin).toBe('library');
    expect(params.xhr.traceId).toBe('trace-1');
    expect(typeof params.xhr.onProgress).toBe('function');

    expect(onPendingChange).toHaveBeenLastCalledWith(4);
    // Photo picks are tiles, not rows.
    expect(document.querySelectorAll('[data-file-tiles] [data-pending-tile]')).toHaveLength(4);
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(4);
    expect(empty()?.disabled).toBe(true);

    await act(async () => params.xhr.onProgress(0.5));
    const bar = document.querySelector('[role="progressbar"][aria-label="Uploading a.png"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
  });

  it('fix 14: failed files show "{n} files didn\'t upload." with Retry and Remove', async () => {
    mockUpload.mockResolvedValue({ ok: false, message: "Couldn't upload. Try again." });
    const onFailedChange = vi.fn();
    await act(async () => {
      root!.render(
        <AttachmentsField
          workspaceId="ws-1"
          value={[]}
          onChange={() => {}}
          frame={FRAME}
          onFailedChange={onFailedChange}
        />,
      );
    });
    await act(async () => pick(mediaInput(), photos('a.png', 'b.png')));
    const bar = document.querySelector('[data-upload-failed]');
    expect(bar?.textContent).toContain("2 files didn't upload.");
    expect(onFailedChange).toHaveBeenLastCalledWith(2);
    expect(document.querySelectorAll('[data-pending-tile][data-failed]')).toHaveLength(2);
    // No old per-file rows in the framed sheet.
    expect(document.querySelector('button[aria-label="Dismiss a.png"]')).toBeNull();

    mockUpload.mockClear();
    await act(async () => buttonByText('Retry')!.click());
    expect(mockUpload).toHaveBeenCalledTimes(2);

    await act(async () => buttonByText('Remove')!.click());
    expect(document.querySelector('[data-upload-failed]')).toBeNull();
    expect(document.querySelectorAll('[data-pending-tile]')).toHaveLength(0);
    expect(onFailedChange).toHaveBeenLastCalledWith(0);
  });

  it("a failed document shows the didn't upload bar with Retry and Remove, and its failure only once", async () => {
    mockUpload.mockResolvedValue({ ok: false, message: "Couldn't upload. Try again." });
    await act(async () => {
      root!.render(
        <AttachmentsField workspaceId="ws-1" value={[]} onChange={() => {}} frame={FRAME} />,
      );
    });
    const docInput = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
      (el) => el.accept === UPLOAD_ACCEPT,
    );
    expect(docInput).toBeDefined();
    await act(async () =>
      pick(docInput!, [new File(['x'], 'brief.pdf', { type: 'application/pdf' })]),
    );

    const bar = document.querySelector('[data-upload-failed]');
    expect(bar?.textContent).toContain("1 file didn't upload.");
    const barButtons = [...(bar?.querySelectorAll('button') ?? [])].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(barButtons).toEqual(['Retry', 'Remove']);

    // The document row still names the file, but the failure is said once (the bar).
    const text = document.body.textContent ?? '';
    expect(text).toContain('brief.pdf');
    expect(text.split("didn't upload").length - 1).toBe(1);
    expect(text).not.toContain("Couldn't upload. Try again.");
    expect(document.querySelector('button[aria-label="Retry brief.pdf"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Dismiss brief.pdf"]')).toBeNull();
    expect(buttonsByText('Retry')).toHaveLength(1);

    await act(async () => buttonByText('Remove')!.click());
    expect(document.querySelector('[data-upload-failed]')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('brief.pdf');
  });
});

describe('AttachmentsField flow A (links)', () => {
  it('extra: a failed link row offers Retry, which tries the link again', async () => {
    mockAddLink.mockResolvedValue({ ok: false, message: "Couldn't add the link. Try again." });
    await act(async () => {
      root!.render(<AttachmentsField workspaceId="ws-1" value={[]} onChange={() => {}} />);
    });
    await act(async () => buttonByText('Link')!.click());
    await act(async () => {
      setValue(
        document.querySelector<HTMLInputElement>('input[aria-label="Link URL"]')!,
        'https://example.com',
      );
      setValue(
        document.querySelector<HTMLInputElement>('input[aria-label="Link name"]')!,
        'Example',
      );
    });
    await act(async () => buttonByText('Add link')!.click());
    expect(mockAddLink).toHaveBeenCalledTimes(1);
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry Example"]');
    expect(retry).not.toBeNull();
    await act(async () => retry!.click());
    expect(mockAddLink).toHaveBeenCalledTimes(2);
  });
});
