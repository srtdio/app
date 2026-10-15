// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpload, newTrace } = vi.hoisted(() => ({
  mockUpload: vi.fn(),
  newTrace: () => 'trace-1',
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } },
}));
vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_UPLOAD_URL: 'https://upload.test' } }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@/lib/chat/attachments', () => ({ uploadChatAttachment: mockUpload }));

import { PresetMediaField, sendingPercent, uploadLine } from './PresetMediaField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mockUpload.mockReset();
  URL.createObjectURL = () => 'blob:photo';
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function pickFile(name: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'.repeat(10)], name, { type: 'image/png' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PresetMediaField', () => {
  it('shows a progress bar from the real upload progress, and never the file name', async () => {
    let finish: (value: { ok: true; reused: false; versionId: string }) => void = () => {};
    mockUpload.mockImplementation(
      (params: { xhr: { onProgress: (f: number) => void } }) =>
        new Promise((resolve) => {
          params.xhr.onProgress(0.42);
          finish = resolve;
        }),
    );
    const onChange = vi.fn();
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <PresetMediaField
          workspaceId="ws-1"
          value={[]}
          onChange={onChange}
          required
          onBusyChange={() => {}}
        />,
      );
    });
    await pickFile('IMG_4821.HEIC.png');
    const bar = document.querySelector('[role="progressbar"]');
    // 42% of the bytes is 38% of the bar: the last 10% waits for the server's answer.
    expect(bar?.getAttribute('aria-valuenow')).toBe('38');
    expect(document.body.textContent).toContain('Uploading, 38%');
    expect(document.body.textContent).not.toContain('IMG_4821');

    await act(async () => finish({ ok: true, reused: false, versionId: 'v-1' }));
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(onChange).toHaveBeenCalledWith([
      { versionId: 'v-1', kind: 'image', name: 'IMG_4821.HEIC.png', previewUrl: 'blob:photo' },
    ]);
  });

  it('retries three times, then gives the plain reason with Try again', async () => {
    mockUpload.mockResolvedValue({ ok: false, message: 'network' });
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <PresetMediaField
          workspaceId="ws-1"
          value={[]}
          onChange={() => {}}
          required
          onBusyChange={() => {}}
        />,
      );
    });
    await pickFile('a.png');
    expect(mockUpload).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).toContain('The file did not reach us.');
    expect(document.body.textContent).toContain('Try again');
  });

  it('never reads 100% before the server answers', () => {
    expect(sendingPercent(1)).toBe(90);
    expect(uploadLine(90, false)).toBe('Almost done, saving your photo');
    expect(uploadLine(10, true)).toBe('The connection dropped. Trying again, 10%');
  });
});
