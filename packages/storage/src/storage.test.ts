import { describe, expect, it } from 'vitest';
import {
  BUCKET_LOCATION_HINT,
  buildR2Key,
  buildThumbnailKey,
  createBucketBody,
  InMemoryMultipartStorage,
  parseListObjectsXml,
  R2StorageClient,
  type TracedFetch,
} from './storage';

const ASSET = '55555555-5555-7555-8555-555555555555';

describe('buildThumbnailKey', () => {
  it('keys a pdf thumbnail under the pdf folder next to the version bytes', () => {
    expect(buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 })).toBe(
      `pdf/${ASSET}/v1-thumb.jpg`,
    );
  });

  it('keys a video thumbnail under the pluralized videos folder', () => {
    expect(buildThumbnailKey({ kind: 'video', assetId: ASSET, versionNumber: 3 })).toBe(
      `videos/${ASSET}/v3-thumb.jpg`,
    );
  });

  it('keys a document thumbnail under the docs folder', () => {
    expect(buildThumbnailKey({ kind: 'document', assetId: ASSET, versionNumber: 2 })).toBe(
      `docs/${ASSET}/v2-thumb.jpg`,
    );
  });

  it('maps image to images and falls back to the kind for other kinds', () => {
    expect(buildThumbnailKey({ kind: 'image', assetId: ASSET, versionNumber: 1 })).toBe(
      `images/${ASSET}/v1-thumb.jpg`,
    );
    expect(buildThumbnailKey({ kind: 'spreadsheet', assetId: ASSET, versionNumber: 1 })).toBe(
      `spreadsheet/${ASSET}/v1-thumb.jpg`,
    );
  });

  it('shares the folder and version prefix of the version key for the same version', () => {
    const versionKey = buildR2Key({
      kind: 'pdf',
      assetId: ASSET,
      versionNumber: 4,
      filename: 'brief.pdf',
    });
    const thumbKey = buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 4 });
    expect(versionKey).toBe(`pdf/${ASSET}/v4-brief.pdf`);
    expect(thumbKey).not.toBe(versionKey);
    expect(thumbKey.slice(0, thumbKey.lastIndexOf('-'))).toBe(
      versionKey.slice(0, versionKey.lastIndexOf('-')),
    );
  });
});

describe('buildR2Key (unchanged)', () => {
  it('keeps the {kindFolder}/{asset}/v{n}-{filename} layout', () => {
    expect(
      buildR2Key({ kind: 'image', assetId: ASSET, versionNumber: 1, filename: 'photo.png' }),
    ).toBe(`images/${ASSET}/v1-photo.png`);
    expect(
      buildR2Key({ kind: 'video', assetId: ASSET, versionNumber: 2, filename: 'clip.mp4' }),
    ).toBe(`videos/${ASSET}/v2-clip.mp4`);
    expect(
      buildR2Key({ kind: 'document', assetId: ASSET, versionNumber: 1, filename: 'a.docx' }),
    ).toBe(`docs/${ASSET}/v1-a.docx`);
    expect(buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'a.pdf' })).toBe(
      `pdf/${ASSET}/v1-a.pdf`,
    );
  });

  it('still sanitizes the filename segment', () => {
    expect(
      buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'my file?.pdf' }),
    ).toBe(`pdf/${ASSET}/v1-my_file_.pdf`);
    expect(buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: '...' })).toBe(
      `pdf/${ASSET}/v1-file`,
    );
  });

  it('keys an uploaded file literally named thumb.jpg to the thumbnail key', () => {
    // The collision the pipeline guards against: same folder, version, and name.
    expect(
      buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'thumb.jpg' }),
    ).toBe(buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 }));
  });
});

describe('InMemoryMultipartStorage listObjects / deleteBucket', () => {
  async function seeded(count: number): Promise<InMemoryMultipartStorage> {
    const storage = new InMemoryMultipartStorage();
    for (let i = 0; i < count; i++) {
      await storage.putObject({
        bucket: 'assets-a',
        key: `images/k${String(i).padStart(3, '0')}`,
        body: new Uint8Array(i + 1),
        contentType: 'image/png',
        traceId: 't',
      });
    }
    await storage.putObject({
      bucket: 'assets-b',
      key: 'images/other',
      body: new Uint8Array(1),
      contentType: 'image/png',
      traceId: 't',
    });
    return storage;
  }

  it('pages through every key of one bucket only, with sizes', async () => {
    const storage = await seeded(5);
    const first = await storage.listObjects({ bucket: 'assets-a', limit: 2 });
    expect(first.objects).toEqual([
      { key: 'images/k000', size: 1 },
      { key: 'images/k001', size: 2 },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const keys = first.objects.map((o) => o.key);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await storage.listObjects({ bucket: 'assets-a', cursor, limit: 2 });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.nextCursor;
    }
    expect(keys).toEqual([
      'images/k000',
      'images/k001',
      'images/k002',
      'images/k003',
      'images/k004',
    ]);
  });

  it('lists only the keys under a prefix', async () => {
    const storage = await seeded(2);
    await storage.putObject({
      bucket: 'assets-a',
      key: 'ws/w1/images/x',
      body: new Uint8Array(1),
      contentType: 'image/png',
      traceId: 't',
    });
    const page = await storage.listObjects({ bucket: 'assets-a', prefix: 'ws/w1/' });
    expect(page.objects.map((o) => o.key)).toEqual(['ws/w1/images/x']);
    expect(page.nextCursor).toBeNull();
  });

  it('returns a single last page when everything fits', async () => {
    const storage = await seeded(2);
    const page = await storage.listObjects({ bucket: 'assets-a' });
    expect(page.objects).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(await storage.listObjects({ bucket: 'missing' })).toEqual({
      objects: [],
      nextCursor: null,
    });
  });

  it('refuses to delete a bucket that still holds objects, then deletes it once empty', async () => {
    const storage = await seeded(1);
    await expect(storage.deleteBucket('assets-a')).rejects.toThrow('BucketNotEmpty');
    await storage.deleteObject('assets-a', 'images/k000');
    await storage.deleteBucket('assets-a');
    expect(storage.buckets.has('assets-a')).toBe(false);
    expect(storage.buckets.has('assets-b')).toBe(true);
    // Idempotent.
    await storage.deleteBucket('assets-a');
  });
});

describe('parseListObjectsXml', () => {
  it('reads keys, sizes and the continuation token of a truncated page', () => {
    const xml =
      '<ListBucketResult><IsTruncated>true</IsTruncated>' +
      '<Contents><Key>docs/a&amp;b.pdf</Key><Size>12</Size></Contents>' +
      '<Contents><Key>images/c.png</Key><Size>3</Size></Contents>' +
      '<NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>';
    expect(parseListObjectsXml(xml)).toEqual({
      objects: [
        { key: 'docs/a&b.pdf', size: 12 },
        { key: 'images/c.png', size: 3 },
      ],
      nextCursor: 'tok&1',
    });
  });

  it('has no cursor on the last page', () => {
    const xml =
      '<ListBucketResult><IsTruncated>false</IsTruncated>' +
      '<Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>';
    expect(parseListObjectsXml(xml).nextCursor).toBeNull();
  });
});

describe('R2StorageClient listObjects / deleteBucket', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  };

  function client(responses: Response[]): {
    r2: R2StorageClient;
    calls: { url: string; method: string }[];
  } {
    const calls: { url: string; method: string }[] = [];
    const fake: TracedFetch = (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      const next = responses.shift();
      return next === undefined ? Promise.reject(new Error('no response')) : Promise.resolve(next);
    };
    return { r2: new R2StorageClient(env, fake), calls };
  }

  it('sends a signed ListObjectsV2 request with the cursor and parses the page', async () => {
    const { r2, calls } = client([
      new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>4</Size></Contents></ListBucketResult>',
        { status: 200 },
      ),
    ]);
    const page = await r2.listObjects({
      bucket: 'assets-a',
      cursor: 'c/1',
      limit: 50,
      traceId: 't',
    });
    expect(page).toEqual({ objects: [{ key: 'a', size: 4 }], nextCursor: null });
    expect(calls[0]).toEqual({
      url: 'https://acct.r2.cloudflarestorage.com/assets-a?continuation-token=c%2F1&list-type=2&max-keys=50',
      method: 'GET',
    });
  });

  it('signs the prefix into the ListObjectsV2 query when one is given', async () => {
    const { r2, calls } = client([
      new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
        status: 200,
      }),
    ]);
    await r2.listObjects({ bucket: 'assets-shared', prefix: 'ws/w1/', limit: 10, traceId: 't' });
    expect(calls[0]).toEqual({
      url: 'https://acct.r2.cloudflarestorage.com/assets-shared?list-type=2&max-keys=10&prefix=ws%2Fw1%2F',
      method: 'GET',
    });
  });

  it('lists a missing bucket as empty and fails loudly on other errors', async () => {
    const { r2 } = client([
      new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }),
      new Response('boom', { status: 500 }),
    ]);
    expect(await r2.listObjects({ bucket: 'gone', traceId: 't' })).toEqual({
      objects: [],
      nextCursor: null,
    });
    await expect(r2.listObjects({ bucket: 'x', traceId: 't' })).rejects.toThrow('(500)');
  });

  it('deletes a bucket, treats a missing one as done, and surfaces BucketNotEmpty', async () => {
    const { r2, calls } = client([
      new Response(null, { status: 204 }),
      new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }),
      new Response('<Error><Code>BucketNotEmpty</Code></Error>', { status: 409 }),
    ]);
    await r2.deleteBucket('assets-a', 't');
    await r2.deleteBucket('assets-a', 't');
    await expect(r2.deleteBucket('assets-b', 't')).rejects.toThrow('BucketNotEmpty');
    expect(calls[0]).toEqual({
      url: 'https://acct.r2.cloudflarestorage.com/assets-a',
      method: 'DELETE',
    });
  });
});

describe('R2StorageClient ensureBucket (Asia-Pacific hint) / copyObject', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  };

  interface Call {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }

  function client(responses: Response[]): { r2: R2StorageClient; calls: Call[] } {
    const calls: Call[] = [];
    const fake: TracedFetch = (input, init) => {
      const raw = init?.body;
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: raw instanceof Uint8Array ? new TextDecoder().decode(raw) : '',
      });
      const next = responses.shift();
      return next === undefined ? Promise.reject(new Error('no response')) : Promise.resolve(next);
    };
    return { r2: new R2StorageClient(env, fake), calls };
  }

  it('creates a new bucket with the apac location hint', async () => {
    const { r2, calls } = client([new Response(null, { status: 200 })]);
    await r2.ensureBucket('assets-new', 't');
    expect(BUCKET_LOCATION_HINT).toBe('apac');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://acct.r2.cloudflarestorage.com/assets-new');
    expect(calls[0]?.body).toBe(createBucketBody('apac'));
    expect(calls[0]?.body).toContain('<LocationConstraint>apac</LocationConstraint>');
  });

  it('treats an already-owned bucket as created, without a second call', async () => {
    const { r2, calls } = client([
      new Response('<Error><Code>BucketAlreadyOwnedByYou</Code></Error>', { status: 409 }),
    ]);
    await r2.ensureBucket('assets-gbl', 't');
    expect(calls).toHaveLength(1);
  });

  it('accepts an existing bucket that rejects the hint (HEAD finds it), fails when it is missing', async () => {
    const { r2, calls } = client([
      new Response('<Error><Code>InvalidLocationConstraint</Code></Error>', { status: 400 }),
      new Response(null, { status: 200 }),
      new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }),
      new Response(null, { status: 404 }),
    ]);
    await r2.ensureBucket('assets-old', 't');
    expect(calls[1]?.method).toBe('HEAD');
    await expect(r2.ensureBucket('assets-x', 't')).rejects.toThrow('(500)');
  });

  it('copies an object server-side with a signed x-amz-copy-source and never deletes', async () => {
    const { r2, calls } = client([
      new Response('<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>', { status: 200 }),
    ]);
    await r2.copyObject({
      sourceBucket: 'assets-gbl',
      targetBucket: 'assets-gbl-apac',
      key: 'images/a b/v1-x.jpg',
      traceId: 't',
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(
      'https://acct.r2.cloudflarestorage.com/assets-gbl-apac/images/a%20b/v1-x.jpg',
    );
    expect(calls[0]?.headers.get('x-amz-copy-source')).toBe('/assets-gbl/images/a%20b/v1-x.jpg');
    expect(calls[0]?.headers.get('Authorization')).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-copy-source;x-amz-date',
    );
    expect(calls.every((call) => call.method !== 'DELETE')).toBe(true);
  });

  it('fails a copy on an error status or a 200 carrying an <Error> body', async () => {
    const { r2 } = client([
      new Response('denied', { status: 403 }),
      new Response('<Error><Code>InternalError</Code></Error>', { status: 200 }),
    ]);
    const input = { sourceBucket: 's', targetBucket: 'assets-t', key: 'k', traceId: 't' };
    await expect(r2.copyObject(input)).rejects.toThrow('(403)');
    await expect(r2.copyObject(input)).rejects.toThrow('InternalError');
  });
});
