// Regression coverage for the R2 signedFetch body omission. objectExists() issues
// a HEAD, and Node's fetch rejects any GET/HEAD request that carries a body, so the
// cutover byte-copy threw on the first image. The SigV4 payload hash (sha256 of the
// empty body) is still computed and signed; only the literal fetch body is dropped.
// No real network: a fake TracedFetch records each call's init and returns a
// caller-controlled Response.

import { describe, expect, it } from 'vitest';

import { R2StorageClient, type TracedFetch } from '@srtdio/storage';

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
};

interface RecordedCall {
  init: RequestInit;
}

function fakeFetchReturning(...statuses: number[]): {
  fetch: TracedFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: TracedFetch = (_input, init) => {
    calls.push({ init: init ?? {} });
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetch, calls };
}

describe('R2StorageClient.objectExists', () => {
  it('sends a bodyless HEAD and preserves the SigV4 content hash header', async () => {
    const { fetch, calls } = fakeFetchReturning(404, 200);
    const client = new R2StorageClient(ENV, fetch);

    const absent = await client.objectExists('bucket', 'images/x/v1-a.jpg', 'trace-1');
    expect(absent).toBe(false);

    const present = await client.objectExists('bucket', 'images/x/v1-a.jpg', 'trace-1');
    expect(present).toBe(true);

    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0]!.init;
    expect(first.method).toBe('HEAD');
    expect(first.body).toBeUndefined();

    const headers = new Headers(first.headers);
    expect(headers.get('x-amz-content-sha256')).not.toBeNull();
  });

  it('keeps the body on a PUT', async () => {
    const { fetch, calls } = fakeFetchReturning(200);
    const client = new R2StorageClient(ENV, fetch);

    await client.putObject({
      bucket: 'bucket',
      key: 'images/x/v1-a.jpg',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
      traceId: 'trace-2',
    });

    expect(calls.length).toBeGreaterThan(0);
    const put = calls[0]!.init;
    expect(put.method).toBe('PUT');
    expect(put.body).toBeDefined();
  });
});
