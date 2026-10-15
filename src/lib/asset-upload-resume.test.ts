import { describe, expect, it } from 'vitest';
import {
  PART_RETRIES,
  RESUMABLE_PART_SIZE,
  RESUME_FAILED_MESSAGE,
  runUploads,
  uploadAssetFile,
  type UploadConfig,
  type UploadFetcher,
} from '@/lib/asset-upload';

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

describe('upload batches', () => {
  it('sends one batch id and the run size for every file of a runUploads run', async () => {
    const worker = fakeWorker();
    const small = (name: string) => new File(['x'], name, { type: 'application/pdf' });
    await runUploads(
      [
        { id: '1', file: small('a.pdf'), filename: 'a.pdf' },
        { id: '2', file: small('b.pdf'), filename: 'b.pdf' },
      ],
      (item) => uploadAssetFile(item.file, config(worker.fetcher, { filename: item.filename })),
    );
    const forms = worker.calls.map((c) => c.body as FormData);
    expect(forms[0]?.get('batch_size')).toBe('2');
    expect(forms[0]?.get('batch_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(forms[1]?.get('batch_id')).toBe(forms[0]?.get('batch_id'));
  });

  it('sends no batch outside a run and never for a chat upload', async () => {
    const worker = fakeWorker();
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    await uploadAssetFile(file, config(worker.fetcher));
    await runUploads([{ id: '1', file, filename: 'a.pdf' }], () =>
      uploadAssetFile(file, config(worker.fetcher, { origin: 'chat' })),
    );
    for (const call of worker.calls) {
      expect((call.body as FormData).get('batch_id')).toBeNull();
    }
  });
});
