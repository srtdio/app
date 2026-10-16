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
          frame={null}
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
      {
        versionId: 'v-1',
        kind: 'image',
        name: 'IMG_4821.HEIC.png',
        previewUrl: 'blob:photo',
        mime: 'image/png',
      },
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
          frame={null}
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

  it('regression: an Instagram Reel with no media shows the empty 9:16 frame as the upload target', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <PresetMediaField
          workspaceId="ws-1"
          value={[]}
          onChange={() => {}}
          required
          onBusyChange={() => {}}
          frame={{ platform: 'instagram', format: 'reel' }}
        />,
      );
    });
    const empty = document.querySelector<HTMLElement>('[data-frame-empty]');
    expect(empty).not.toBeNull();
    expect(Number(empty!.getAttribute('data-frame-ratio'))).toBeCloseTo(9 / 16);
    expect(empty!.style.width).toBe('min(100%, 33.75vh)');
    expect(empty!.className).toContain('bg-panel-2');
    const target = empty!.querySelector('button')!;
    expect(target.textContent).toBe('Add a photo or video');
    await act(async () => target.click());
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('is no longer a fixed square: media fill the platform frame, and a format change re-shapes it', async () => {
    const photo = {
      versionId: 'v-1',
      kind: 'image' as const,
      name: 'p.png',
      previewUrl: 'blob:p',
      mime: 'image/png',
    };
    const view = (format: string) => (
      <PresetMediaField
        workspaceId="ws-1"
        value={[photo]}
        onChange={() => {}}
        required
        onBusyChange={() => {}}
        frame={{ platform: 'instagram', format }}
      />
    );
    root = createRoot(host!);
    await act(async () => root!.render(view('single_image')));
    const framed = () => document.querySelector<HTMLElement>('[data-frame-ratio]');
    expect(document.querySelector('.h-20.w-20')).toBeNull();
    expect(framed()?.hasAttribute('data-frame-empty')).toBe(false);
    expect(Number(framed()?.getAttribute('data-frame-ratio'))).toBeCloseTo(4 / 5);
    expect(framed()?.querySelector('img')?.className).toContain('object-cover');
    expect(document.querySelector('button[aria-label="Remove photo"]')?.className).toContain(
      'h-11 w-11',
    );
    await act(async () => root!.render(view('story')));
    expect(Number(framed()?.getAttribute('data-frame-ratio'))).toBeCloseTo(9 / 16);
  });
});
