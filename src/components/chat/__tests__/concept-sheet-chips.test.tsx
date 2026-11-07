// @vitest-environment jsdom
// Decision F (one pending-file chip) and E (Save busy on its Button) in the
// concept sheet, for a Plan concept and a Bank idea alike: an upload is a
// ui/PendingChip with the ring (X cancels), a failed one offers Retry, and Save
// waits as busy on its own Button with its label kept.

import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { ToastProvider } from '@/components/ui/toast';
import type { AttachmentUploader, ChatAttachmentUpload } from '@/lib/chat/attachments';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(30));

interface Call {
  file: File;
  signal: AbortSignal | undefined;
  resolve: (outcome: ChatAttachmentUpload) => void;
}

function Harness(props: {
  upload: AttachmentUploader;
  noDate?: boolean;
  initial?: ConceptForm;
  onSubmit?: () => void;
}): ReactElement {
  const [form, setForm] = useState<ConceptForm>(
    props.initial ?? { ...EMPTY_CONCEPT, title: 'Reel' },
  );
  return (
    <ToastProvider>
      <ConceptSheet
        open
        mode="add"
        form={form}
        onChange={setForm}
        onSubmit={props.onSubmit ?? (() => undefined)}
        onClose={() => undefined}
        uploadFile={props.upload}
        {...(props.noDate === true ? { noDate: true } : {})}
      />
    </ToastProvider>
  );
}

async function mount(props: Parameters<typeof Harness>[0]): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness {...props} />));
  await settle();
}

async function pick(...names: string[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-plan-concept-upload-input]');
  if (input === null) throw new Error('no upload input');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map((n) => new File([new Uint8Array(2048)], n, { type: 'image/png' })),
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

function recorder(): { upload: AttachmentUploader; calls: Call[] } {
  const calls: Call[] = [];
  const upload: AttachmentUploader = (file, _progress, signal) =>
    new Promise<ChatAttachmentUpload>((resolve) => calls.push({ file, signal, resolve }));
  return { upload, calls };
}

const save = () => document.querySelector<HTMLButtonElement>('[data-plan-concept-save]');

beforeEach(() => {
  resetHistorySteps();
  URL.createObjectURL = vi.fn(() => 'blob:a');
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe.each([
  ['Plan concept', false],
  ['Bank idea', true],
])('%s: upload chips are ui/PendingChip', (_name, noDate) => {
  it('uploading: the ring on the thumb with the size meta; its X cancels the upload', async () => {
    const { upload, calls } = recorder();
    await mount({ upload, noDate });
    await pick('a.png');
    const chip = document.querySelector('[data-plan-concept-upload="uploading"]');
    expect(chip?.getAttribute('data-pending-chip')).toBe('uploading');
    expect(chip?.querySelector('[data-upload-ring]')).not.toBeNull();
    expect(chip?.querySelector('[data-pending-chip-meta]')?.textContent).toBe('2 KB');
    expect(chip?.textContent ?? '').not.toMatch(/%/);
    const x = chip?.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload"]');
    await act(async () => x?.click());
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(document.querySelector('[data-plan-concept-upload]')).toBeNull();
  });

  it('failed: "Couldn\'t upload" with Retry, which uploads it again', async () => {
    const { upload, calls } = recorder();
    await mount({ upload, noDate });
    await pick('a.png');
    await act(async () => calls[0]?.resolve({ ok: false, message: 'nope' }));
    await settle();
    const chip = document.querySelector('[data-plan-concept-upload="error"]');
    expect(chip?.getAttribute('data-pending-chip')).toBe('failed');
    const retry = chip?.querySelector<HTMLButtonElement>('button[aria-label="Retry a.png"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(calls).toHaveLength(2);
    expect(document.querySelector('[data-plan-concept-upload="uploading"]')).not.toBeNull();
  });

  it('attached files are ready chips; the trailing X removes one', async () => {
    const { upload } = recorder();
    await mount({
      upload,
      noDate,
      initial: {
        ...EMPTY_CONCEPT,
        title: 'Reel',
        files: [{ versionId: 'v1', name: 'deck.pdf' }],
      },
    });
    const chip = document.querySelector('[data-plan-concept-file]');
    expect(chip?.getAttribute('data-pending-chip')).toBe('ready');
    expect(chip?.querySelector('[data-pending-chip-meta]')?.textContent).toBe('PDF');
    await act(async () =>
      chip?.querySelector<HTMLButtonElement>('button[aria-label="Remove deck.pdf"]')?.click(),
    );
    expect(document.querySelector('[data-plan-concept-file]')).toBeNull();
  });

  it('Save while an upload runs: busy on the Button, its label kept, then it goes', async () => {
    const { upload, calls } = recorder();
    const onSubmit = vi.fn();
    await mount({ upload, noDate, onSubmit });
    await pick('a.png');
    await act(async () => save()?.click());
    expect(save()?.getAttribute('aria-busy')).toBe('true');
    expect(save()?.textContent).toContain('Add');
    expect(save()?.textContent).not.toContain('Uploading');
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => calls[0]?.resolve({ ok: true, reused: false, versionId: 'v-a' }));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('ConceptSheet description: ui/WritingBox field mode', () => {
  it('a field-mode box, labelled Description; the Aa row and Emoji show on focus, no @', async () => {
    const { upload } = recorder();
    await mount({ upload });
    const area = document.querySelector<HTMLTextAreaElement>('[data-plan-concept-description]');
    const box = area?.closest<HTMLElement>('[data-writing-box]');
    expect(box?.dataset.mode).toBe('field');
    expect(area?.labels?.[0]?.textContent).toBe('Description');
    expect(box?.querySelector('[aria-label="Bold"]')).toBeNull();
    await act(async () => area?.focus());
    expect(box?.querySelector('[aria-label="Bold"]')).not.toBeNull();
    expect(box?.querySelector('[aria-label="Emoji"]')).not.toBeNull();
    expect(box?.querySelector('[aria-label="Mention"]')).toBeNull();
  });
});
