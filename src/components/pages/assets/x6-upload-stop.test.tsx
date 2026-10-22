// @vitest-environment jsdom
// X6 upload queue: Stop, system Back and an unmount while files are going up.
// The sheet renders for real in jsdom; the per-file upload is a fake that
// resolves on demand and honours the AbortSignal like the XHR transport.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetUploadSheet,
  STOPPED_MESSAGE,
  isStoppedOutcome,
  precheckSummary,
  stoppableUpload,
  uploadStoppedLabel,
} from '@/components/pages/assets/AssetUploadSheet';
import { runUploads, type QueueItem, type UploadOutcome } from '@/lib/asset-upload';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OK: UploadOutcome = { ok: true, reused: false, assetId: 'asset-x' };
const NETWORK: UploadOutcome = { ok: false, message: "Couldn't upload. Try again." };

interface Pending {
  name: string;
  signal: AbortSignal | undefined;
  resolve: (outcome: UploadOutcome) => void;
}

let root: Root | null = null;
let pending: Pending[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

function fakeSubmit() {
  return vi.fn(
    (file: File, _name: string, _folder: string | null, signal?: AbortSignal) =>
      new Promise<UploadOutcome>((resolve) => {
        pending.push({ name: file.name, signal, resolve });
        // Like the XHR transport: an abort ends the request as a transport failure.
        signal?.addEventListener('abort', () => resolve(NETWORK), { once: true });
      }),
  );
}

async function mount(onSubmit: ReturnType<typeof fakeSubmit>) {
  const onToast = vi.fn();
  const onSummary = vi.fn();
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AssetUploadSheet
        open
        onClose={onClose}
        onSubmit={onSubmit}
        onToast={onToast}
        onSummary={onSummary}
      />,
    );
  });
  return { onToast, onSummary, onClose };
}

async function pick(count: number): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const files = Array.from(
    { length: count },
    (_, i) => new File(['x'], `photo-${i + 1}.png`, { type: 'image/png' }),
  );
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

async function startUpload(count: number): Promise<void> {
  await pick(count);
  await act(async () => button(`Upload ${count}`)?.click());
  // The Back guard places its step after the commit (a microtask).
  await settle();
}

async function finish(index: number, outcome: UploadOutcome = OK): Promise<void> {
  await act(async () => {
    pending[index]?.resolve(outcome);
    await wait(0);
  });
}

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(60);
  });
}

beforeEach(() => {
  resetHistorySteps();
  pending = [];
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = () => {};
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('X6 system Back during an upload', () => {
  it('shows the Stop confirm, and Keep uploading continues the same run', async () => {
    const onSubmit = fakeSubmit();
    const { onSummary, onClose } = await mount(onSubmit);
    await startUpload(3);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Every upload lands in the library root: there are no folders.
    expect(onSubmit.mock.calls[0]?.[2]).toBeNull();
    const runSignal = pending[0]?.signal;

    await pressBack();
    expect(confirm()?.textContent).toContain('Stop uploading?');
    expect(confirm()?.textContent).toContain(
      'Files already uploaded stay. The rest are cancelled.',
    );
    expect(button('Keep uploading')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      button('Keep uploading')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(runSignal?.aborted).toBe(false);

    await finish(0);
    await finish(1);
    await finish(2);
    // Same run: every file went up under the one signal, never aborted.
    expect(onSubmit).toHaveBeenCalledTimes(3);
    expect(pending.every((p) => p.signal === runSignal)).toBe(true);
    expect(onSummary).toHaveBeenCalledWith({ title: 'Uploaded 3 files', sticky: false });
  });
});

describe('X6 Stop while uploading', () => {
  it('replaces Cancel with a 44px Stop while running', async () => {
    await mount(fakeSubmit());
    await startUpload(2);
    const stop = button('Stop');
    expect(stop).toBeDefined();
    expect(stop?.className).toContain('h-11');
    expect(button('Cancel')).toBeUndefined();
  });

  it('aborts the file in flight, keeps finished ones and starts no more', async () => {
    const onSubmit = fakeSubmit();
    const { onSummary, onClose } = await mount(onSubmit);
    await startUpload(3);
    await finish(0);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    const inFlight = pending[1]?.signal;

    await act(async () => button('Stop')?.click());
    expect(confirm()?.textContent).toContain('Stop uploading?');
    const confirmStop = [...(confirm()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Stop',
    );
    await act(async () => {
      confirmStop?.click();
      await wait(0);
    });
    await settle();

    expect(inFlight?.aborted).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSummary).toHaveBeenCalledWith({
      title: 'Upload stopped. 1 of 3 files uploaded.',
      sticky: false,
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('X6 the sheet goes away mid-run', () => {
  it('unmounting aborts the file in flight and toasts how many went up', async () => {
    const onSubmit = fakeSubmit();
    const { onToast } = await mount(onSubmit);
    await startUpload(3);
    await finish(0);
    const inFlight = pending[1]?.signal;

    act(() => root?.unmount());
    root = null;
    await settle();

    expect(inFlight?.aborted).toBe(true);
    expect(onToast).toHaveBeenCalledWith('Upload stopped. 1 of 3 files uploaded.');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('X6 stoppableUpload with the unchanged runUploads', () => {
  it('returns stopped for the aborted file and every file after it', async () => {
    const controller = new AbortController();
    let stopped = false;
    const seen: string[] = [];
    const upload = stoppableUpload(
      async (item: QueueItem, signal) => {
        seen.push(item.id);
        if (item.id === 'b') {
          stopped = true;
          controller.abort();
          return signal.aborted ? NETWORK : OK;
        }
        return OK;
      },
      { stopped: () => stopped, signal: controller.signal },
    );
    const items: QueueItem[] = ['a', 'b', 'c'].map((id) => ({
      id,
      file: new File(['x'], `${id}.png`, { type: 'image/png' }),
      filename: `${id}.png`,
    }));
    const outcomes: UploadOutcome[] = [];
    const result = await runUploads(items, upload, {
      onResult: (_id, outcome) => outcomes.push(outcome),
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result.succeeded).toEqual(['a']);
    expect(outcomes.slice(1).every(isStoppedOutcome)).toBe(true);
    expect(STOPPED_MESSAGE).toBe('Not uploaded');
  });

  it('a file that finished before Stop still counts as uploaded', async () => {
    let stopped = false;
    const upload = stoppableUpload(
      async () => {
        stopped = true;
        return OK;
      },
      { stopped: () => stopped, signal: new AbortController().signal },
    );
    const outcome = await upload({
      id: 'a',
      file: new File(['x'], 'a.png', { type: 'image/png' }),
      filename: 'a.png',
    });
    expect(outcome.ok).toBe(true);
  });
});

describe('X6 copy for the queue', () => {
  it('states the stopped count and one summary for pre-check rejections', () => {
    expect(uploadStoppedLabel(2, 5)).toBe('Upload stopped. 2 of 5 files uploaded.');
    expect(uploadStoppedLabel(0, 1)).toBe('Upload stopped. 0 of 1 file uploaded.');
    expect(precheckSummary([])).toBeNull();
    expect(precheckSummary([{ name: 'big.mov', message: 'Files up to 100MB only' }])).toBe(
      'big.mov: Files up to 100MB only',
    );
    expect(
      precheckSummary([
        { name: 'a.exe', message: "This file type isn't supported" },
        { name: 'b.exe', message: "This file type isn't supported" },
      ]),
    ).toBe("2 files weren't added. Their file type isn't supported.");
    expect(
      precheckSummary([
        { name: 'a.exe', message: "This file type isn't supported" },
        { name: 'big.mov', message: 'Files up to 100MB only' },
      ]),
    ).toBe("2 files weren't added. Files up to 100MB only, in a supported type.");
  });
});
