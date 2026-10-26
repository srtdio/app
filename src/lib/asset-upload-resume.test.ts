import { describe, expect, it, vi } from 'vitest';
import {
  PART_RETRIES,
  RESUMABLE_PART_SIZE,
  RESUME_FAILED_MESSAGE,
  uploadAssetFile,
  type UploadConfig,
  type UploadFetcher,
} from '@/lib/asset-upload';
import type { ThumbnailResult } from '@/lib/files/thumbnail';

const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const BASE = 'https://upload.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A two-and-a-bit part PDF (real bytes so slices have real sizes). */
function bigFile(): File {
  return new File([new Uint8Array(RESUMABLE_PART_SIZE * 2 + 3)], 'big.pdf', {
    type: 'application/pdf',
  });
}

interface Call {
  method: string;
  path: string;
  part: number | null;
  body: BodyInit | null | undefined;
}

/**
 * A fake worker. `failPart(n, attempt)` decides whether the attempt-th send of
 * part n fails at the transport (true) or is stored but its reply lost ('lost').
 */
function fakeWorker(failPart: (part: number, attempt: number) => boolean | 'lost' = () => false) {
  const calls: Call[] = [];
  const stored = new Map<number, number>();
  const attempts = new Map<number, number>();
  const fetcher: UploadFetcher = async (input, init) => {
    const url = new URL(input);
    const part = url.searchParams.get('part_number');
    calls.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      part: part === null ? null : Number(part),
      body: init.body,
    });
    switch (url.pathname) {
      case '/multipart/create':
        return jsonResponse(201, {
          key: '_uploads/u/k',
          upload_id: 'up-1',
          part_size: RESUMABLE_PART_SIZE,
        });
      case '/multipart/part': {
        const n = Number(part);
        const attempt = (attempts.get(n) ?? 0) + 1;
        attempts.set(n, attempt);
        const fail = failPart(n, attempt);
        if (fail === true) throw new TypeError('Failed to fetch');
        stored.set(n, (init.body as Blob).size);
        if (fail === 'lost') throw new TypeError('Failed to fetch');
        return jsonResponse(200, { part_number: n, etag: `"e${n}"` });
      }
      case '/multipart/parts':
        return jsonResponse(200, {
          parts: [...stored.entries()].map(([n, size]) => ({ part_number: n, size })),
        });
      case '/multipart/complete':
        return jsonResponse(201, { asset: { assetId: 'a1', versionId: 'v1', reused: false } });
      case '/multipart/abort':
        return jsonResponse(200, { ok: true });
      default:
        return jsonResponse(201, { asset: { assetId: 'a0', versionId: 'v0', reused: false } });
    }
  };
  return { calls, fetcher };
}

function config(fetcher: UploadFetcher, extra: Partial<UploadConfig> = {}): UploadConfig {
  return {
    endpoint: BASE,
    token: 't',
    workspaceId: WORKSPACE,
    origin: 'library',
    filename: 'big.pdf',
    fetcher,
    makeThumbnail: () => Promise.resolve({ ok: false, reason: 'failed' }),
    sleep: () => Promise.resolve(),
    ...extra,
  } as UploadConfig;
}

describe('resumable upload', () => {
  it('sends a file over 8 MB as create, 8 MB parts, then complete without the file', async () => {
    const worker = fakeWorker();
    const outcome = await uploadAssetFile(bigFile(), config(worker.fetcher));
    expect(outcome).toMatchObject({ ok: true, assetId: 'a1', assetVersionId: 'v1' });
    expect(worker.calls.map((c) => `${c.method} ${c.path}${c.part ?? ''}`)).toEqual([
      'POST /multipart/create',
      'PUT /multipart/part1',
      'PUT /multipart/part2',
      'PUT /multipart/part3',
      'POST /multipart/complete',
    ]);
    const sizes = worker.calls.filter((c) => c.part !== null).map((c) => (c.body as Blob).size);
    expect(sizes).toEqual([RESUMABLE_PART_SIZE, RESUMABLE_PART_SIZE, 3]);
    const form = worker.calls.at(-1)?.body as FormData;
    expect(form.get('file')).toBeNull();
    expect(form.get('key')).toBe('_uploads/u/k');
    expect(form.get('upload_id')).toBe('up-1');
    expect(form.get('filename')).toBe('big.pdf');
    expect(form.get('content_type')).toBe('application/pdf');
  });

  it('keeps a file of one part or less on the direct POST', async () => {
    const worker = fakeWorker();
    const small = new File([new Uint8Array(RESUMABLE_PART_SIZE)], 'a.pdf', {
      type: 'application/pdf',
    });
    await uploadAssetFile(small, config(worker.fetcher));
    expect(worker.calls.map((c) => c.path)).toEqual(['/']);
  });

  it('resumes after a dropped part from the last finished one', async () => {
    const worker = fakeWorker((part, attempt) => part === 2 && attempt === 1);
    const outcome = await uploadAssetFile(bigFile(), config(worker.fetcher));
    expect(outcome.ok).toBe(true);
    const sent = worker.calls.map((c) => `${c.method} ${c.path}${c.part ?? ''}`);
    expect(sent).toEqual([
      'POST /multipart/create',
      'PUT /multipart/part1',
      'PUT /multipart/part2',
      'GET /multipart/parts',
      'PUT /multipart/part2',
      'PUT /multipart/part3',
      'POST /multipart/complete',
    ]);
  });

  it('does not resend a part that landed when only its reply was lost', async () => {
    const worker = fakeWorker((part, attempt) => (part === 1 && attempt === 1 ? 'lost' : false));
    const outcome = await uploadAssetFile(bigFile(), config(worker.fetcher));
    expect(outcome.ok).toBe(true);
    expect(worker.calls.filter((c) => c.part === 1)).toHaveLength(1);
  });

  it(`fails with a plain reason after ${PART_RETRIES} retries and aborts the upload`, async () => {
    const worker = fakeWorker((part) => part === 2);
    const outcome = await uploadAssetFile(bigFile(), config(worker.fetcher));
    expect(outcome).toEqual({ ok: false, message: RESUME_FAILED_MESSAGE });
    expect(worker.calls.filter((c) => c.part === 2)).toHaveLength(PART_RETRIES + 1);
    await Promise.resolve();
    expect(worker.calls.at(-1)?.path).toBe('/multipart/abort');
    expect(RESUME_FAILED_MESSAGE).not.toMatch(/connect|offline|network/i);
    expect(RESUME_FAILED_MESSAGE).not.toContain('—');
  });

  it('maps a refused create (over the cap) to the existing copy', async () => {
    const fetcher: UploadFetcher = () =>
      Promise.resolve(jsonResponse(413, { error: { code: 'file_too_large', message: 'x' } }));
    const outcome = await uploadAssetFile(bigFile(), config(fetcher));
    expect(outcome).toEqual({ ok: false, message: 'Files up to 100MB only' });
  });
});

describe('thumbnail alongside the original', () => {
  it('starts the thumbnail at once and sends every part without waiting for it', async () => {
    let finishThumbnail: (result: ThumbnailResult) => void = () => undefined;
    const makeThumbnail = vi.fn(
      () =>
        new Promise<ThumbnailResult>((resolve) => {
          finishThumbnail = resolve;
        }),
    );
    const worker = fakeWorker();
    // Whether the thumbnail had started (and not finished) when each part went out.
    let thumbnailDone = false;
    const seenAtPart: { started: number; done: boolean }[] = [];
    const fetcher: UploadFetcher = (input, init) => {
      if (new URL(input).pathname === '/multipart/part') {
        seenAtPart.push({ started: makeThumbnail.mock.calls.length, done: thumbnailDone });
      }
      return worker.fetcher(input, init);
    };

    const upload = uploadAssetFile(bigFile(), config(fetcher, { makeThumbnail }));
    for (let i = 0; i < 50 && seenAtPart.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // All three parts of the original went up while the thumbnail was still being made.
    expect(seenAtPart).toEqual([
      { started: 1, done: false },
      { started: 1, done: false },
      { started: 1, done: false },
    ]);
    // The complete call (which carries the thumbnail) waits for it.
    expect(worker.calls.map((c) => c.path)).not.toContain('/multipart/complete');

    thumbnailDone = true;
    finishThumbnail({
      ok: true,
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      width: 580,
      height: 800,
      pageCount: 4,
    });
    const outcome = await upload;

    expect(outcome.ok).toBe(true);
    const form = worker.calls.at(-1)?.body as FormData;
    expect(worker.calls.at(-1)?.path).toBe('/multipart/complete');
    expect(form.get('thumbnail')).toBeInstanceOf(Blob);
    expect(form.get('thumbnail_page_count')).toBe('4');
  });

  it('a thumbnail that fails never holds up or fails the original', async () => {
    const worker = fakeWorker();
    const outcome = await uploadAssetFile(
      bigFile(),
      config(worker.fetcher, { makeThumbnail: () => Promise.reject(new Error('decode')) }),
    );
    expect(outcome.ok).toBe(true);
    const form = worker.calls.at(-1)?.body as FormData;
    expect(form.get('thumbnail')).toBeNull();
  });
});

describe('resumable progress per part over XHR', () => {
  /** A fake XHR worker: each part PUT reports its bytes in halves, then succeeds. */
  function xhrWorker(failFirstPart2 = false) {
    let part2Attempts = 0;
    return (): XMLHttpRequest => {
      const request = {
        url: '',
        status: 0,
        responseText: '',
        upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        ontimeout: null as (() => void) | null,
        open(_method: string, url: string) {
          request.url = url;
        },
        setRequestHeader() {},
        abort() {},
        send(body: unknown) {
          const path = new URL(request.url).pathname;
          const reply = (status: number, json: unknown): void => {
            request.status = status;
            request.responseText = JSON.stringify(json);
            request.onload?.();
          };
          if (path === '/multipart/create') {
            reply(201, { key: 'k', upload_id: 'u' });
          } else if (path === '/multipart/part') {
            const size = (body as Blob).size;
            const part = Number(new URL(request.url).searchParams.get('part_number'));
            const tick = (loaded: number): void =>
              request.upload.onprogress?.({
                lengthComputable: true,
                loaded,
                total: size,
              } as ProgressEvent);
            tick(size / 2);
            if (part === 2 && failFirstPart2 && part2Attempts === 0) {
              part2Attempts += 1;
              request.onerror?.();
              return;
            }
            tick(size);
            reply(200, { part_number: part });
          } else if (path === '/multipart/parts') {
            reply(200, { parts: [] });
          } else {
            reply(201, { asset: { assetId: 'a1', versionId: 'v1', reused: false } });
          }
        },
      };
      return request as unknown as XMLHttpRequest;
    };
  }

  function xhrConfig(createRequest: () => XMLHttpRequest, onProgress: (f: number) => void) {
    return {
      endpoint: BASE,
      token: 't',
      workspaceId: WORKSPACE,
      origin: 'library' as const,
      filename: 'big.pdf',
      makeThumbnail: () => Promise.resolve({ ok: false, reason: 'failed' } as const),
      sleep: () => Promise.resolve(),
      xhr: { traceId: 'trace-1', createRequest, onProgress },
    };
  }

  it('reports bytes sent inside each part, not only when a part ends', async () => {
    const progress: number[] = [];
    const file = bigFile();
    const outcome = await uploadAssetFile(
      file,
      xhrConfig(xhrWorker(), (f) => progress.push(f)),
    );
    expect(outcome.ok).toBe(true);
    const half = RESUMABLE_PART_SIZE / 2;
    expect(progress).toEqual([
      half / file.size,
      RESUMABLE_PART_SIZE / file.size,
      (RESUMABLE_PART_SIZE + half) / file.size,
      (RESUMABLE_PART_SIZE * 2) / file.size,
      (RESUMABLE_PART_SIZE * 2 + 1.5) / file.size,
      1,
    ]);
  });

  it('never moves backward when a part is retried', async () => {
    const progress: number[] = [];
    const outcome = await uploadAssetFile(
      bigFile(),
      xhrConfig(xhrWorker(true), (f) => progress.push(f)),
    );
    expect(outcome.ok).toBe(true);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1] ?? -1);
    }
    expect(progress.at(-1)).toBe(1);
  });
});
