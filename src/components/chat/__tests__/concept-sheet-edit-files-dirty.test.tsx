// @vitest-environment jsdom
// F3: Edit concept's dirty guard counts files once they are known. The
// baseline is the files as loaded (at open when already read, else when the
// read lands); after that a removed or added file asks "Discard this concept?"
// on Cancel (the same `dirty` the Sheet's X, backdrop, Back and Escape use).
// While the files still load only the title, description and date count.

import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
// Thumbnails would presign; the guard is all that is under test.
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import {
  ConceptSheet,
  conceptDirty,
  type ConceptFilesState,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { ToastProvider } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

const TEXT: ConceptForm = { title: 'Reel', description: 'Morning light', date: '', files: [] };
const FILES = [
  { versionId: 'v1', name: 'File 1' },
  { versionId: 'v2', name: 'File 2' },
];

// The parent as PlanItemScreen holds it: the form in state; `land` sets the
// files and the 'ready' state together, as useConceptFilesRead's onLoaded does.
let land: (() => void) | null = null;

function Harness(props: {
  initial: ConceptForm;
  initialState: ConceptFilesState;
  onClose: () => void;
}): ReactElement {
  const [form, setForm] = useState(props.initial);
  const [filesState, setFilesState] = useState<ConceptFilesState>(props.initialState);
  land = () => {
    setForm((f) => ({ ...f, files: FILES }));
    setFilesState('ready');
  };
  return (
    <ToastProvider>
      <ConceptSheet
        open
        mode="edit"
        form={form}
        onChange={setForm}
        onSubmit={() => undefined}
        onClose={props.onClose}
        filesState={filesState}
        onRetryFiles={() => undefined}
      />
    </ToastProvider>
  );
}

async function mount(initial: ConceptForm, initialState: ConceptFilesState) {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness initial={initial} initialState={initialState} onClose={onClose} />);
  });
  await settle();
  return { onClose };
}

const cancel = () => document.querySelector<HTMLButtonElement>('[data-plan-concept-cancel]');
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const removeFirst = () =>
  document.querySelector<HTMLButtonElement>('[data-plan-concept-file-remove]');

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  land = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('F3: conceptDirty compares Edit files once known', () => {
  it('ignores Edit files while unknown; compares them once known; Add unchanged', () => {
    const was: ConceptForm = { ...TEXT, files: FILES };
    const fewer: ConceptForm = { ...TEXT, files: FILES.slice(0, 1) };
    expect(conceptDirty({ mode: 'edit', form: fewer, baseline: was, uploads: 0 })).toBe(false);
    expect(
      conceptDirty({ mode: 'edit', form: fewer, baseline: was, uploads: 0, filesKnown: false }),
    ).toBe(false);
    expect(
      conceptDirty({ mode: 'edit', form: fewer, baseline: was, uploads: 0, filesKnown: true }),
    ).toBe(true);
    expect(
      conceptDirty({ mode: 'edit', form: was, baseline: was, uploads: 0, filesKnown: true }),
    ).toBe(false);
    expect(conceptDirty({ mode: 'add', form: fewer, baseline: was, uploads: 0 })).toBe(true);
  });
});

describe('F3: Edit concept sheet asks before losing a file change', () => {
  it('files read at open: removing one makes Cancel ask', async () => {
    const { onClose } = await mount({ ...TEXT, files: FILES }, 'ready');
    await act(async () => removeFirst()?.click());
    await act(async () => cancel()?.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm()?.textContent).toContain('Discard this concept?');
  });

  it('files read at open and untouched: Cancel closes at once', async () => {
    const { onClose } = await mount({ ...TEXT, files: FILES }, 'ready');
    await act(async () => cancel()?.click());
    expect(confirm()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('files still loading: a clean sheet closes; once loaded the loaded files are the baseline', async () => {
    const { onClose } = await mount(TEXT, 'loading');
    await act(async () => cancel()?.click());
    expect(confirm()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    // The read lands: the loaded files are not a change.
    await act(async () => land?.());
    await act(async () => cancel()?.click());
    expect(confirm()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
    // Removing a loaded file is.
    await act(async () => removeFirst()?.click());
    await act(async () => cancel()?.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(confirm()?.textContent).toContain('Discard this concept?');
  });
});
