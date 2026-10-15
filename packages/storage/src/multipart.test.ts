import { describe, expect, it } from 'vitest';
import { R2StorageClient, completeMultipartXml, parseListPartsXml } from './storage';

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
};

describe('multipart XML', () => {
  it('parses ListParts into sorted parts with unescaped ETags', () => {
    const xml =
      '<ListPartsResult><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag><Size>4</Size></Part>' +
      '<Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag><Size>8388608</Size></Part></ListPartsResult>';
    expect(parseListPartsXml(xml)).toEqual([
      { partNumber: 1, etag: '"a"', size: 8388608 },
      { partNumber: 2, etag: '"b"', size: 4 },
    ]);
  });

  it('builds the complete body in part order with escaped ETags', () => {
    expect(
      completeMultipartXml([
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ]),
    ).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>',
    );
  });
});

describe('R2StorageClient multipart requests', () => {
  function recording(response: () => Response) {
    const calls: { url: string; method: string; auth: string }[] = [];
    const client = new R2StorageClient(env, (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('Authorization') ?? '',
      });
      return Promise.resolve(response());
    });
    return { client, calls };
  }

  it('creates with ?uploads= and reads the UploadId', async () => {
    const { client, calls } = recording(
      () =>
        new Response(
          '<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>',
        ),
    );
    const id = await client.createMultipartUpload({
      bucket: 'b',
      key: '_uploads/x/y',
      contentType: 'application/pdf',
      traceId: 't',
    });
    expect(id).toBe('u-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://acct.r2.cloudflarestorage.com/b/_uploads/x/y?uploads=',
    });
    expect(calls[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=akid\//);
  });

  it('sends part number and upload id as sorted, encoded query params', async () => {
    const { client, calls } = recording(
      () => new Response(null, { status: 200, headers: { ETag: '"e1"' } }),
    );
    const etag = await client.uploadPart({
      bucket: 'b',
      key: 'k',
      uploadId: 'a/b+c',
      partNumber: 3,
      body: new Uint8Array([1]),
      traceId: 't',
    });
    expect(etag).toBe('"e1"');
    expect(calls[0]?.url).toBe(
      'https://acct.r2.cloudflarestorage.com/b/k?partNumber=3&uploadId=a%2Fb%2Bc',
    );
  });

  it('reports a gone upload as null on list and false on complete', async () => {
    const gone = () => new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
    const { client } = recording(gone);
    expect(
      await client.listParts({ bucket: 'b', key: 'k', uploadId: 'u', traceId: 't' }),
    ).toBeNull();
    expect(
      await client.completeMultipartUpload({
        bucket: 'b',
        key: 'k',
        uploadId: 'u',
        parts: [],
        traceId: 't',
      }),
    ).toBe(false);
  });
});
