import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// The library picker reads the workspace; it is closed here, so stub it.
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
// The Sheet portals into document.body; render it in place for static markup.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}));

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Result } from '@srtdio/rpc';
import {
  CONCEPT_FILES_LIMIT_HINT,
  CONCEPT_FILES_READ_FAILED,
  CONCEPT_SAVE_UPLOADING,
  ConceptSheet,
  conceptFilesRoom,
  type ConceptFilesState,
  type ConceptForm,
} from '@/components/chat/ConceptSheet';
import { CONCEPT_FILES_MAX } from '@/components/chat/plan-card';
import { ToastProvider } from '@/components/ui/toast';
import type { ChatAttachmentUpload } from '@/lib/chat/attachments';
import {
  CONCEPT_UPLOAD_FAILED,
  conceptEditArgs,
  conceptSaveGate,
  createConceptFilesRead,
  createConceptUploads,
  readConceptFiles,
  type ConceptUpload,
} from '@/lib/chat/plans';

const file = (name: string, type = 'image/png'): File => new File(['x'], name, { type });

interface Pending {
  file: File;
  signal: AbortSignal | undefined;
  resolve: (outcome: ChatAttachmentUpload) => void;
}

function harness() {
  const calls: Pending[] = [];
  const uploaded: Array<{ versionId: string; name: string }> = [];
  let list: readonly ConceptUpload[] = [];
  const uploads = createConceptUploads({
    upload: (f, _progress, signal) =>
      new Promise<ChatAttachmentUpload>((resolve) => calls.push({ file: f, signal, resolve })),
    precheck: () => ({ ok: true }),
    onChange: (next) => {
      list = next;
    },
    onUploaded: (versionId, name) => uploaded.push({ versionId, name }),
  });
  return { uploads, calls, uploaded, list: () => list };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('concept uploads (U1, U2)', () => {
  it('every picked file starts at once, through the injected (comments) uploader', () => {
    const h = harness();
    h.uploads.add([file('a.png'), file('b.png')]);
    expect(h.calls.map((c) => c.file.name)).toEqual(['a.png', 'b.png']);
    expect(h.list().map((u) => u.status.state)).toEqual(['uploading', 'uploading']);
  });

  it('a finished upload leaves the list and joins the file list', async () => {
    const h = harness();
    h.uploads.add([file('a.png')]);
    h.calls[0]?.resolve({ ok: true, reused: false, versionId: 'v-a' });
    await flush();
    expect(h.list()).toEqual([]);
    expect(h.uploaded).toEqual([{ versionId: 'v-a', name: 'a.png' }]);
  });

  it('a precheck refusal fails the file without any request', () => {
    const uploads: ConceptUpload[][] = [];
    const upload = vi.fn();
    const c = createConceptUploads({
      upload,
      precheck: () => ({ ok: false, message: 'Files up to 100MB only' }),
      onChange: (next) => uploads.push([...next]),
      onUploaded: vi.fn(),
    });
    c.add([file('big.mov', 'video/quicktime')]);
    expect(upload).not.toHaveBeenCalled();
    expect(uploads.at(-1)?.[0]?.status).toEqual({
      state: 'error',
      message: 'Files up to 100MB only',
    });
  });
});

describe('Save waits for uploads, a failure blocks it (U3)', () => {
  it('gates: wait while in flight, refuse on a failure, go when clear', async () => {
    const h = harness();
    expect(conceptSaveGate(h.list())).toBe('go');
    h.uploads.add([file('a.png'), file('b.png')]);
    expect(conceptSaveGate(h.list())).toBe('wait');
    h.calls[0]?.resolve({ ok: false, message: 'Upload failed. Try again' });
    await flush();
    expect(conceptSaveGate(h.list())).toBe('wait');
    h.calls[1]?.resolve({ ok: true, reused: false, versionId: 'v-b' });
    await flush();
    expect(conceptSaveGate(h.list())).toBe('refuse');
    expect(h.list()[0]?.status).toEqual({ state: 'error', message: 'Upload failed. Try again' });
  });

  it('retry clears the block once it lands', async () => {
    const h = harness();
    h.uploads.add([file('a.png')]);
    h.calls[0]?.resolve({ ok: false, message: 'x' });
    await flush();
    const id = h.list()[0]?.id ?? '';
    h.uploads.retry(id);
    expect(h.calls).toHaveLength(2);
    expect(conceptSaveGate(h.list())).toBe('wait');
    h.calls[1]?.resolve({ ok: true, reused: false, versionId: 'v-a' });
    await flush();
    expect(conceptSaveGate(h.list())).toBe('go');
    expect(h.uploaded.map((u) => u.versionId)).toEqual(['v-a']);
  });

  it('remove clears the block and nothing of that file is kept', async () => {
    const h = harness();
    h.uploads.add([file('a.png')]);
    h.calls[0]?.resolve({ ok: false, message: 'x' });
    await flush();
    h.uploads.remove(h.list()[0]?.id ?? '');
    expect(h.list()).toEqual([]);
    expect(conceptSaveGate(h.list())).toBe('go');
    expect(h.uploaded).toEqual([]);
  });

  it('the refusal toast copy', () => {
    expect(CONCEPT_UPLOAD_FAILED).toBe("Couldn't upload. Try again.");
  });
});

describe('closing aborts uploads (U4)', () => {
  it('abortAll aborts every request and a late answer adds nothing', async () => {
    const h = harness();
    h.uploads.add([file('a.png'), file('b.png')]);
    h.uploads.abortAll();
    expect(h.calls.every((c) => c.signal?.aborted === true)).toBe(true);
    expect(h.list()).toEqual([]);
    h.calls[0]?.resolve({ ok: true, reused: false, versionId: 'v-a' });
    await flush();
    expect(h.uploaded).toEqual([]);
    expect(h.list()).toEqual([]);
  });

  it('removing an upload in flight aborts it', () => {
    const h = harness();
    h.uploads.add([file('a.png')]);
    h.uploads.remove(h.list()[0]?.id ?? '');
    expect(h.calls[0]?.signal?.aborted).toBe(true);
  });

  it('previews are revoked on remove and on close', () => {
    const revoke = vi.fn();
    const c = createConceptUploads({
      upload: () => new Promise(() => {}),
      precheck: () => ({ ok: true }),
      onChange: () => {},
      onUploaded: () => {},
      preview: (f) => `blob:${f.name}`,
      revoke,
    });
    c.add([file('a.png'), file('b.png')]);
    c.abortAll();
    expect(revoke.mock.calls.map((x) => x[0])).toEqual(['blob:a.png', 'blob:b.png']);
  });
});

describe('the files read (U5)', () => {
  afterEach(() => vi.useRealTimers());

  it('a read slower than 5s resolves to a failure and is aborted', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const query = {
      in: () => query,
      eq: () => query,
      is: () => query,
      order: () => query,
      select: () => query,
      abortSignal: (signal: AbortSignal) => {
        seen = signal;
        return new Promise(() => {});
      },
    };
    const client = { from: () => query } as unknown as Parameters<typeof readConceptFiles>[0];
    const result = readConceptFiles(client, 'item-1', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(seen?.aborted).toBe(true);
  });

  it('loading, then failed; Retry reads again and a success goes to onLoaded', async () => {
    const states: string[] = [];
    const loaded: string[][] = [];
    const answers: Array<(r: Result<string[]>) => void> = [];
    const read = createConceptFilesRead({
      load: () => new Promise((resolve) => answers.push(resolve)),
      onState: (s) => states.push(s),
      onLoaded: (f) => loaded.push(f),
    });
    read.start();
    answers[0]?.({ ok: false, error: { code: 'unknown', message: 'read timed out' } });
    await flush();
    expect(states).toEqual(['loading', 'failed']);
    read.start();
    expect(states.at(-1)).toBe('loading');
    answers[1]?.({ ok: true, data: ['v1', 'v2'] });
    await flush();
    expect(loaded).toEqual([['v1', 'v2']]);
  });

  it('stop aborts the read and nothing is reported after', async () => {
    const states: string[] = [];
    let signal: AbortSignal | undefined;
    let answer: (r: Result<string[]>) => void = () => {};
    const onLoaded = vi.fn();
    const read = createConceptFilesRead({
      load: (cancel) => {
        signal = cancel;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      onState: (s) => states.push(s),
      onLoaded,
    });
    read.start();
    read.stop();
    expect(signal?.aborted).toBe(true);
    answer({ ok: true, data: ['v1'] });
    await flush();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(states).toEqual(['loading']);
  });
});

const dir = fileURLToPath(new URL('..', import.meta.url));
const src = (path: string): string => readFileSync(`${dir}${path}`, 'utf8');

const uploader = (): Promise<ChatAttachmentUpload> => new Promise(() => {});

// The Sheet's portal target; never touched beyond being passed along.
vi.stubGlobal('document', { body: {} });

function sheet(opts: {
  files?: number;
  filesState?: ConceptFilesState;
  upload?: boolean;
  mode?: 'add' | 'edit';
}): string {
  const form: ConceptForm = {
    title: 'Reel',
    description: '',
    date: '',
    files: Array.from({ length: opts.files ?? 0 }, (_, i) => ({
      versionId: `v${i}`,
      name: `File ${i + 1}`,
    })),
  };
  return renderToStaticMarkup(
    <ToastProvider>
      <ConceptSheet
        open
        mode={opts.mode ?? 'edit'}
        form={form}
        onChange={() => {}}
        onSubmit={() => {}}
        onClose={() => {}}
        {...(opts.filesState !== undefined ? { filesState: opts.filesState } : {})}
        onRetryFiles={() => {}}
        {...(opts.upload !== false ? { uploadFile: uploader } : {})}
      />
    </ToastProvider>,
  );
}

describe('the sheet (U1, U2, U5)', () => {
  it('Upload sits beside the library picker in add and edit', () => {
    for (const mode of ['add', 'edit'] as const) {
      const html = sheet({ mode });
      expect(html).toContain('data-plan-concept-files=""');
      expect(html).toContain('data-plan-concept-upload-pick=""');
      expect(html).toContain('>Upload<');
    }
    expect(sheet({ upload: false })).not.toContain('data-plan-concept-upload-pick');
  });

  it('20 files across picks and uploads: a hint, buttons still enabled', () => {
    expect(conceptFilesRoom(0, 0)).toBe(CONCEPT_FILES_MAX);
    expect(conceptFilesRoom(12, 5)).toBe(3);
    expect(conceptFilesRoom(15, 5)).toBe(0);
    expect(conceptFilesRoom(20, 3)).toBe(0);
    expect(CONCEPT_FILES_LIMIT_HINT).toBe('You can add up to 20 files.');
    const full = sheet({ files: CONCEPT_FILES_MAX });
    expect(full).toContain(CONCEPT_FILES_LIMIT_HINT);
    expect(full).not.toMatch(/data-plan-concept-files=""[^>]*disabled/);
    expect(full).not.toMatch(/data-plan-concept-upload-pick=""[^>]*disabled/);
    expect(sheet({ files: CONCEPT_FILES_MAX - 1 })).not.toContain(CONCEPT_FILES_LIMIT_HINT);
  });

  it('a pick past the room is cut to the room, counting uploads', () => {
    const sheetSrc = src('ConceptSheet.tsx');
    expect(sheetSrc).toContain(
      'picked.slice(0, conceptFilesRoom(form.files.length, uploads.length))',
    );
    expect(sheetSrc).toContain('next.slice(0, CONCEPT_FILES_MAX - uploads.length)');
  });

  it('loading: the skeleton row, no Add or Upload', () => {
    const html = sheet({ filesState: 'loading', files: 0 });
    expect(html).toContain('data-plan-concept-files-loading=""');
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('data-plan-concept-files=""');
    expect(html).not.toContain('data-plan-concept-upload-pick');
  });

  it('failed or timed out: "Couldn\'t load files." with a 44px Retry, no Add or Upload', () => {
    const html = sheet({ filesState: 'failed' });
    expect(CONCEPT_FILES_READ_FAILED).toBe("Couldn't load files.");
    expect(html).toContain('t load files.');
    const retry = /<button[^>]*data-plan-concept-files-retry=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(retry).toMatch(/class="[^"]*\bh-11\b/);
    expect(retry).toMatch(/class="[^"]*\brounded-lg\b/);
    expect(html).not.toContain('data-plan-concept-files=""');
    expect(html).not.toContain('data-plan-concept-upload-pick');
  });

  it('Save reads "Uploading..." while it waits', () => {
    expect(CONCEPT_SAVE_UPLOADING).toBe('Uploading...');
    const sheetSrc = src('ConceptSheet.tsx');
    expect(sheetSrc).toContain("{waiting ? CONCEPT_SAVE_UPLOADING : edit ? 'Save' : 'Add'}");
    // A second tap while waiting does nothing.
    expect(sheetSrc).toMatch(/const save = \(\): void => \{\s*if \(waiting\) return;/);
  });
});

describe('library origin (U1)', () => {
  it('both screens upload through the comments hook, which sends library', () => {
    const hook = readFileSync(`${dir}../../lib/chat/use-chat-attachments.ts`, 'utf8');
    expect(hook).toMatch(
      /export function useCommentAttachments\(\): ChatAttachments \{\s*return useAttachments\('library'\);/,
    );
    for (const screen of ['PlanComposeScreen.tsx', 'PlanItemScreen.tsx']) {
      const s = src(screen);
      expect(s).toContain('useCommentAttachments()');
      expect(s).not.toContain('useChatAttachments');
      expect(s).toContain('{...(canAttach ? { uploadFile } : {})}');
    }
  });
});

describe('a failed files read never replaces links (U5)', () => {
  it('files unknown: the edit sends files as null', () => {
    const args = conceptEditArgs(
      'item-1',
      {
        title: 'Reel',
        description: '',
        targetDate: null,
        currentFiles: null,
        pickedFiles: null,
      },
      'trace',
    );
    expect(args.p_attachment_version_ids).toBeNull();
    const item = src('PlanItemScreen.tsx');
    expect(item).toContain(
      'pickedFiles: editFiles !== null ? editForm.files.map((f) => f.versionId) : null',
    );
    expect(item).toContain("filesState={editFiles !== null ? 'ready' : filesRead.state}");
    expect(item).toContain('props.open && editOpen && editFiles === null');
  });
});
