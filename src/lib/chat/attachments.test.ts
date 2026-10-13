import { describe, expect, it, vi } from 'vitest';

import { precheckFile } from '@/lib/asset-upload';
import {
  buildAttachmentExt,
  buildMessageExt,
  canSendAttachmentMessage,
  classifyAttachment,
  parseAttachments,
  parseReply,
  parseSharedPostIds,
  precheckImage,
  toMessageAttachment,
  toLocalAttachment,
  awaitsUpload,
  uploadProgress,
  withoutLocal,
  splitAlbum,
  buildAttachmentMeta,
  parseAttachmentMeta,
  uploadChatAttachment,
  type ChatUploadParams,
  type MessageAttachment,
  type ReplyQuote,
  uploadRing,
  classifyFileKind,
  rememberThumbnail,
  thumbnailMetaOf,
} from '@/lib/chat/attachments';

function fakeFile(name: string, type: string): File {
  return { name, type } as unknown as File;
}

function workerResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';

describe('uploadChatAttachment', () => {
  it('uploads via the asset-upload pipeline and carries the VERSION id, not the asset id', async () => {
    // The worker returns both ids; the chat layer must surface the version id so
    // the render path (asset-read on asset_versions.id) resolves instead of 404ing.
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        workerResponse(201, { asset: { assetId: ASSET_ID, versionId: VERSION_ID, reused: false } }),
      );
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    const outcome = await uploadChatAttachment({
      file,
      workspaceId: 'ws-1',
      origin: 'chat',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({ ok: true, reused: false, versionId: VERSION_ID });
    if (outcome.ok) expect(outcome.versionId).not.toBe(ASSET_ID);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    const form = init.body as FormData;
    expect(form.get('workspace_id')).toBe('ws-1');
    expect(form.get('origin')).toBe('chat');
    expect((form.get('file') as File).name).toBe('photo.png');
  });

  it("forwards origin 'library' (post/brief fields and comments) unchanged", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        workerResponse(201, { asset: { assetId: ASSET_ID, versionId: VERSION_ID, reused: false } }),
      );
    await uploadChatAttachment({
      file: new File(['x'], 'brief.pdf', { type: 'application/pdf' }),
      workspaceId: 'ws-1',
      origin: 'library',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('origin')).toBe('library');
  });

  it('requires origin at the type level', () => {
    const fetcher = vi.fn();
    // @ts-expect-error origin is required: no caller may forget it.
    const params: ChatUploadParams = {
      file: new File(['x'], 'a.png', { type: 'image/png' }),
      workspaceId: 'ws-1',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    };
    expect(params).toBeDefined();
  });

  it('treats a reused (200) response as success and still carries the version id', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        workerResponse(200, { asset: { assetId: ASSET_ID, versionId: VERSION_ID, reused: true } }),
      );

    const outcome = await uploadChatAttachment({
      file: new File(['x'], 'a.pdf', { type: 'application/pdf' }),
      workspaceId: 'ws-1',
      origin: 'chat',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({ ok: true, reused: true, versionId: VERSION_ID });
  });

  it('fails closed when a success response carries no version id', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(workerResponse(201, { asset: { assetId: ASSET_ID, reused: false } }));

    const outcome = await uploadChatAttachment({
      file: new File(['x'], 'a.png', { type: 'image/png' }),
      workspaceId: 'ws-1',
      origin: 'chat',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({
      ok: false,
      message: 'Upload failed. Try again',
    });
  });

  it('surfaces an upload failure as a Result and never throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));

    const outcome = await uploadChatAttachment({
      file: new File(['x'], 'a.pdf', { type: 'application/pdf' }),
      workspaceId: 'ws-1',
      origin: 'chat',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({
      ok: false,
      message: 'Upload failed. Try again',
    });
  });
});

describe('precheckImage gates the Photo path to images', () => {
  it('rejects a non-image allowlisted file on the Photo path', () => {
    expect(precheckImage(fakeFile('doc.pdf', 'application/pdf'))).toEqual({
      ok: false,
      message: 'Photos must be an image file',
    });
  });

  it('accepts the same non-image file on the File path (full allowlist)', () => {
    expect(precheckFile(fakeFile('doc.pdf', 'application/pdf'))).toEqual({ ok: true });
  });

  it('accepts an image on the Photo path', () => {
    expect(precheckImage(fakeFile('photo.png', 'image/png'))).toEqual({ ok: true });
  });
});

describe('buildAttachmentExt', () => {
  it('carries attachment_asset_ids plus client render metadata', () => {
    const attachments: MessageAttachment[] = [
      { assetId: 'a1', name: 'one.png', mime: 'image/png' },
      { assetId: 'a2', name: 'two.pdf', mime: 'application/pdf' },
    ];
    expect(buildAttachmentExt(attachments)).toEqual({
      attachment_asset_ids: ['a1', 'a2'],
      attachment_meta: [
        { assetId: 'a1', name: 'one.png', mime: 'image/png' },
        { assetId: 'a2', name: 'two.pdf', mime: 'application/pdf' },
      ],
    });
  });
});

describe('buildMessageExt', () => {
  it('carries shared_post_ids alongside the attachment ids + render meta', () => {
    const attachments: MessageAttachment[] = [
      { assetId: 'a1', name: 'one.png', mime: 'image/png' },
    ];
    expect(buildMessageExt({ attachments, sharedPostIds: ['p1', 'p2'], reply: null })).toEqual({
      attachment_asset_ids: ['a1'],
      attachment_meta: [{ assetId: 'a1', name: 'one.png', mime: 'image/png' }],
      shared_post_ids: ['p1', 'p2'],
    });
  });

  it('carries shared posts with no attachments (shared-posts-only send)', () => {
    expect(buildMessageExt({ attachments: [], sharedPostIds: ['p1'], reply: null })).toEqual({
      attachment_asset_ids: [],
      attachment_meta: [],
      shared_post_ids: ['p1'],
    });
  });

  it('carries reply_to when a reply quote is supplied', () => {
    const reply: ReplyQuote = { id: 'm9', authorUserId: 'u7', preview: 'see this' };
    const result = buildMessageExt({ attachments: [], sharedPostIds: [], reply });
    expect(result.reply_to).toEqual({ id: 'm9', author_user_id: 'u7', preview: 'see this' });
  });

  it('omits the reply_to key entirely when reply is null', () => {
    const result = buildMessageExt({ attachments: [], sharedPostIds: [], reply: null });
    expect('reply_to' in result).toBe(false);
  });
});

describe('parseReply', () => {
  it('reads a valid reply_to off the ext', () => {
    expect(parseReply({ reply_to: { id: 'm9', author_user_id: 'u7', preview: 'hello' } })).toEqual({
      id: 'm9',
      authorUserId: 'u7',
      preview: 'hello',
    });
  });

  it('maps an absent or non-string author_user_id to null', () => {
    expect(parseReply({ reply_to: { id: 'm9', preview: 'hi' } })).toEqual({
      id: 'm9',
      authorUserId: null,
      preview: 'hi',
    });
    expect(parseReply({ reply_to: { id: 'm9', author_user_id: 7, preview: 'hi' } })).toEqual({
      id: 'm9',
      authorUserId: null,
      preview: 'hi',
    });
  });

  it('returns null when reply_to is missing, the ext is not an object, or id/preview are absent', () => {
    expect(parseReply({ shared_post_ids: ['p1'] })).toBeNull();
    expect(parseReply(undefined)).toBeNull();
    expect(parseReply(null)).toBeNull();
    expect(parseReply({ reply_to: { author_user_id: 'u7', preview: 'hi' } })).toBeNull();
    expect(parseReply({ reply_to: { id: 'm9', author_user_id: 'u7' } })).toBeNull();
  });
});

describe('parseSharedPostIds', () => {
  it('reads the shared_post_ids array off the ext', () => {
    expect(parseSharedPostIds({ shared_post_ids: ['p1', 'p2'] })).toEqual(['p1', 'p2']);
  });

  it('ignores non-string entries and returns [] when absent', () => {
    expect(parseSharedPostIds({ shared_post_ids: ['p1', 7, null] })).toEqual(['p1']);
    expect(parseSharedPostIds({ attachment_asset_ids: ['a1'] })).toEqual([]);
    expect(parseSharedPostIds(undefined)).toEqual([]);
  });
});

describe('parseAttachments', () => {
  it('prefers the rich attachment_meta', () => {
    expect(
      parseAttachments({
        attachment_asset_ids: ['a1'],
        attachment_meta: [{ assetId: 'a1', name: 'one.png', mime: 'image/png' }],
      }),
    ).toEqual([{ assetId: 'a1', name: 'one.png', mime: 'image/png' }]);
  });

  it('falls back to bare attachment_asset_ids when no meta is present', () => {
    expect(parseAttachments({ attachment_asset_ids: ['a1', 'a2'] })).toEqual([
      { assetId: 'a1', name: '', mime: '' },
      { assetId: 'a2', name: '', mime: '' },
    ]);
  });

  it('returns [] for a message with no ext / no attachments', () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments({})).toEqual([]);
    expect(parseAttachments({ mentions: ['x'] })).toEqual([]);
  });
});

describe('classifyAttachment', () => {
  it('routes images to the thumbnail branch and everything else to the file chip', () => {
    expect(classifyAttachment('image/png')).toBe('image');
    expect(classifyAttachment('image/jpeg')).toBe('image');
    expect(classifyAttachment('application/pdf')).toBe('file');
    expect(classifyAttachment('')).toBe('file');
  });

  it('routes audio mimes to the voice-note branch', () => {
    expect(classifyAttachment('audio/webm')).toBe('audio');
    expect(classifyAttachment('audio/mp4')).toBe('audio');
    expect(classifyAttachment('audio/mpeg')).toBe('audio');
  });
});

describe('voice-note transcripts are never written', () => {
  it('leaves a transcript out of the ext, and still reads a legacy one back', () => {
    const attachments: MessageAttachment[] = [
      { assetId: 'v1', name: 'note.webm', mime: 'audio/webm', transcript: 'hello there' },
    ];
    const ext = buildAttachmentExt(attachments);
    expect(ext.attachment_meta).toEqual([{ assetId: 'v1', name: 'note.webm', mime: 'audio/webm' }]);
    expect('transcript' in ext.attachment_meta[0]!).toBe(false);
    const legacy = {
      attachment_asset_ids: ['v1'],
      attachment_meta: [
        { assetId: 'v1', name: 'note.webm', mime: 'audio/webm', transcript: 'hello there' },
      ],
    };
    expect(parseAttachments(legacy)).toEqual([
      { assetId: 'v1', name: 'note.webm', mime: 'audio/webm', transcript: 'hello there' },
    ]);
  });
});

describe('canSendAttachmentMessage', () => {
  it('blocks an empty send (no text, no attachments)', () => {
    expect(
      canSendAttachmentMessage({
        text: '   ',
        attachmentCount: 0,
        sending: false,
      }),
    ).toBe(false);
  });

  it('allows attachments-only, text-only, and shared-posts-only', () => {
    expect(canSendAttachmentMessage({ text: '', attachmentCount: 1, sending: false })).toBe(true);
    expect(
      canSendAttachmentMessage({
        text: 'hi',
        attachmentCount: 0,
        sending: false,
      }),
    ).toBe(true);
    // Shared-posts-only: no text, no attachments, but a post is queued.
    expect(
      canSendAttachmentMessage({
        text: '   ',
        attachmentCount: 0,
        sharedPostCount: 1,
        sending: false,
      }),
    ).toBe(true);
  });

  it('blocks a fully empty send even with the shared-post field present', () => {
    expect(
      canSendAttachmentMessage({
        text: '',
        attachmentCount: 0,
        sharedPostCount: 0,
        sending: false,
      }),
    ).toBe(false);
  });

  it('never blocks on an upload (files upload after Send); blocks only while a send is settling', () => {
    // A picked file with no text is sendable at once: the upload runs in the outbox.
    expect(canSendAttachmentMessage({ text: '', attachmentCount: 1, sending: false })).toBe(true);
    expect(canSendAttachmentMessage({ text: 'hi', attachmentCount: 1, sending: true })).toBe(false);
  });
});

describe('toMessageAttachment', () => {
  it('builds the attachment from the file and the uploaded VERSION id', () => {
    expect(toMessageAttachment(fakeFile('doc.pdf', 'application/pdf'), VERSION_ID)).toEqual({
      assetId: VERSION_ID,
      name: 'doc.pdf',
      mime: 'application/pdf',
    });
  });
});

describe('buildAttachmentMeta / parseAttachmentMeta', () => {
  it('round-trips mime, name, size and duration; never writes a transcript', () => {
    const meta = buildAttachmentMeta([
      {
        assetId: 'v1',
        name: 'a.webm',
        mime: 'audio/webm',
        size: 9,
        durationMs: 1500,
        transcript: 'hi',
      },
      { assetId: 'v2', name: 'b.webm', mime: 'audio/webm' },
    ]);
    expect(meta).toEqual({
      v1: { mime: 'audio/webm', name: 'a.webm', size: 9, duration_ms: 1500 },
      v2: { mime: 'audio/webm', name: 'b.webm', size: 0 },
    });
    expect(parseAttachmentMeta(meta, ['v1', 'v2', 'v3'])).toEqual([
      { assetId: 'v1', name: 'a.webm', mime: 'audio/webm', size: 9, durationMs: 1500 },
      { assetId: 'v2', name: 'b.webm', mime: 'audio/webm', size: 0 },
      { assetId: 'v3', name: '', mime: '' },
    ]);
    // A legacy row that carries a transcript still reads back.
    expect(
      parseAttachmentMeta({ v1: { mime: 'audio/webm', name: 'a', size: 1, transcript: 'hi' } }, [
        'v1',
      ]),
    ).toEqual([{ assetId: 'v1', name: 'a', mime: 'audio/webm', size: 1, transcript: 'hi' }]);
    expect(parseAttachmentMeta(null, ['v1'])).toEqual([{ assetId: 'v1', name: '', mime: '' }]);
  });
});

describe('local attachment (instant send)', () => {
  const file = new File(['abc'], 'photo.png', { type: 'image/png' });
  const upload = vi.fn();

  it('carries the File, its preview, mime, name, size and progress 0, with no asset id yet', () => {
    const a = toLocalAttachment(file, 'blob:preview-1', upload);
    expect(a).toMatchObject({
      assetId: '',
      name: 'photo.png',
      mime: 'image/png',
      size: 3,
      local: { file, previewUrl: 'blob:preview-1', progress: 0, upload },
    });
    expect(a.local?.key).toMatch(/^local-/);
    expect(toLocalAttachment(file, null, upload).local?.key).not.toBe(a.local?.key);
    expect(awaitsUpload(a)).toBe(true);
    expect(uploadProgress(a)).toBe(0);
  });

  it('is done once the version id lands: no progress to show, nothing to upload', () => {
    const a = toLocalAttachment(file, 'blob:preview-1', upload);
    const done: MessageAttachment = { ...a, assetId: VERSION_ID };
    expect(awaitsUpload(done)).toBe(false);
    expect(uploadProgress(done)).toBeNull();
    expect(uploadProgress({ assetId: VERSION_ID, name: 'x.png', mime: 'image/png' })).toBeNull();
  });

  it('never reaches the wire, attachment_meta or storage', () => {
    const a: MessageAttachment = {
      ...toLocalAttachment(file, 'blob:preview-1', upload),
      assetId: VERSION_ID,
    };
    expect(withoutLocal(a)).toEqual({
      assetId: VERSION_ID,
      name: 'photo.png',
      mime: 'image/png',
      size: 3,
    });
    expect(buildAttachmentExt([a]).attachment_meta).toEqual([withoutLocal(a)]);
    expect(buildAttachmentMeta([a])).toEqual({
      [VERSION_ID]: { mime: 'image/png', name: 'photo.png', size: 3 },
    });
  });
});

describe('uploadChatAttachment over XHR', () => {
  it('reads the version id off the XHR response and reports progress', async () => {
    const progress: number[] = [];
    const request = fakeXhr(201, { asset: { assetId: ASSET_ID, versionId: VERSION_ID } }, [
      [1, 4],
      [4, 4],
    ]);
    const outcome = await uploadChatAttachment({
      file: new File(['x'], 'photo.png', { type: 'image/png' }),
      workspaceId: 'ws-1',
      origin: 'chat',
      token: 'jwt',
      endpoint: 'https://upload',
      xhr: {
        traceId: 'trace-x',
        onProgress: (f) => progress.push(f),
        createRequest: () => request,
      },
    });
    expect(outcome).toEqual({ ok: true, reused: false, versionId: VERSION_ID });
    expect(progress).toEqual([0.25, 1]);
    expect(request.headers).toEqual({ Authorization: 'Bearer jwt', 'X-Trace-Id': 'trace-x' });
  });
});

/** A minimal XMLHttpRequest double: answers `status`/`body` after emitting `ticks`. */
function fakeXhr(
  status: number,
  body: unknown,
  ticks: [number, number][] = [],
): XMLHttpRequest & { headers: Record<string, string> } {
  const request = {
    headers: {} as Record<string, string>,
    status: 0,
    responseText: '',
    upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
    open: vi.fn(),
    setRequestHeader(name: string, value: string) {
      request.headers[name] = value;
    },
    send() {
      for (const [loaded, total] of ticks) {
        request.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
      }
      request.status = status;
      request.responseText = JSON.stringify(body);
      request.onload?.();
    },
  };
  return request as unknown as XMLHttpRequest & { headers: Record<string, string> };
}

describe('splitAlbum', () => {
  const img = (id: string): MessageAttachment => ({
    assetId: id,
    name: `${id}.png`,
    mime: 'image/png',
  });
  const pdf: MessageAttachment = { assetId: 'f', name: 'brief.pdf', mime: 'application/pdf' };
  const voice: MessageAttachment = { assetId: 'v', name: 'note.webm', mime: 'audio/webm' };

  it('puts every image into the album in send order and keeps the rest below', () => {
    expect(splitAlbum([img('a'), pdf, img('b'), voice])).toEqual({
      images: [img('a'), img('b')],
      others: [pdf, voice],
    });
  });

  it('returns an empty album when there are no images', () => {
    expect(splitAlbum([pdf])).toEqual({ images: [], others: [pdf] });
  });
});

describe('T3: voice note peaks ride the DB meta and the live ext', () => {
  const peaks = Array.from({ length: 48 }, (_, i) => (i * 7) % 101);
  const voice: MessageAttachment = {
    assetId: 'ver-v',
    name: 'voice-note.webm',
    mime: 'audio/webm',
    size: 10,
    durationMs: 4000,
    peaks,
  };

  it('DB meta: written as `peaks` and read back', () => {
    const meta = buildAttachmentMeta([voice]);
    expect(meta['ver-v']?.peaks).toEqual(peaks);
    // Round trip through JSON, as Postgres stores it.
    const back = parseAttachmentMeta(JSON.parse(JSON.stringify(meta)), ['ver-v']);
    expect(back[0]?.peaks).toEqual(peaks);
  });

  it('live ext: carried in attachment_meta and read back', () => {
    const ext = buildMessageExt({ attachments: [voice], sharedPostIds: [], reply: null });
    const back = parseAttachments(JSON.parse(JSON.stringify(ext)));
    expect(back[0]?.peaks).toEqual(peaks);
  });

  it.each([
    ['a string', 'x'],
    ['too long', new Array<number>(49).fill(3)],
    ['a NaN (null in JSON)', [1, null]],
    ['an object', { a: 1 }],
  ])('invalid peaks (%s) are absent; the attachment still renders', (_label, bad) => {
    const db = parseAttachmentMeta(
      { 'ver-v': { mime: 'audio/webm', name: 'voice-note.webm', size: 1, peaks: bad } },
      ['ver-v'],
    );
    expect(db[0]?.mime).toBe('audio/webm');
    expect(db[0]).not.toHaveProperty('peaks');
    const live = parseAttachments({
      attachment_asset_ids: ['ver-v'],
      attachment_meta: [
        { assetId: 'ver-v', name: 'voice-note.webm', mime: 'audio/webm', peaks: bad },
      ],
    });
    expect(live[0]?.mime).toBe('audio/webm');
    expect(live[0]).not.toHaveProperty('peaks');
  });

  it('values out of range are clamped 0..100', () => {
    const db = parseAttachmentMeta(
      { 'ver-v': { mime: 'audio/webm', name: 'n', size: 1, peaks: [-5, 50, 500] } },
      ['ver-v'],
    );
    expect(db[0]?.peaks).toEqual([0, 50, 100]);
  });

  it('notes without peaks stay without the key', () => {
    const plain = { ...voice };
    delete plain.peaks;
    expect(buildAttachmentMeta([plain])['ver-v']).not.toHaveProperty('peaks');
    expect(buildAttachmentExt([plain]).attachment_meta[0]).not.toHaveProperty('peaks');
  });
});

describe('uploadRing (the X and its progress)', () => {
  const file = new File(['abc'], 'a.png', { type: 'image/png' });
  const att = (
    over: Partial<MessageAttachment>,
    local?: Partial<NonNullable<MessageAttachment['local']>>,
  ) =>
    ({
      assetId: '',
      name: 'a.png',
      mime: 'image/png',
      size: 100,
      ...over,
      local: { key: 'k', file, previewUrl: null, progress: 0, ...local },
    }) as MessageAttachment;

  it('null when nothing awaits upload (the X is gone)', () => {
    expect(uploadRing([att({ assetId: 'v' }, { progress: 1 })])).toBeNull();
    expect(uploadRing([{ assetId: 'v', name: 'n', mime: 'image/png' }])).toBeNull();
  });

  it('unknown (spins) while no request runs', () => {
    expect(uploadRing([att({}, { progress: 0.4 })])).toEqual({ progress: null });
  });

  it('bytes sent over all bytes of the message', () => {
    expect(
      uploadRing([
        att({ assetId: 'v', size: 100 }, { progress: 1 }),
        att({ size: 300 }, { progress: 0.5, uploading: true }),
      ]),
    ).toEqual({ progress: 250 / 400 });
  });
});

describe('classifyFileKind (the file bubble branch)', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['video/mp4', 'video'],
    ['video/quicktime', 'video'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'office'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'office'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'office'],
    ['text/csv', 'file'],
    ['application/zip', 'file'],
    ['', 'file'],
  ] as const)('%s -> %s', (mime, kind) => {
    expect(classifyFileKind(mime)).toBe(kind);
  });

  it('classifyAttachment keeps its three list-preview kinds', () => {
    expect(classifyAttachment('application/pdf')).toBe('file');
    expect(classifyAttachment('video/mp4')).toBe('file');
  });
});

describe('thumbnail meta: send, read back, invalid values dropped', () => {
  const pdf: MessageAttachment = {
    assetId: 'v-pdf',
    name: 'deck.pdf',
    mime: 'application/pdf',
    size: 900,
    pageCount: 12,
    thumbW: 580,
    thumbH: 751,
  };

  it('live ext round-trip keeps pageCount / thumbW / thumbH', () => {
    const ext = buildAttachmentExt([pdf]);
    expect(ext.attachment_meta[0]).toMatchObject({ pageCount: 12, thumbW: 580, thumbH: 751 });
    expect(parseAttachments(JSON.parse(JSON.stringify(ext)))).toEqual([pdf]);
  });

  it('Postgres attachment_meta round-trip keeps page_count / thumb_w / thumb_h', () => {
    const meta = buildAttachmentMeta([pdf]);
    expect(meta['v-pdf']).toEqual({
      mime: 'application/pdf',
      name: 'deck.pdf',
      size: 900,
      page_count: 12,
      thumb_w: 580,
      thumb_h: 751,
    });
    expect(parseAttachmentMeta(JSON.parse(JSON.stringify(meta)), ['v-pdf'])).toEqual([pdf]);
  });

  it('a file with no stored thumbnail writes none of the keys', () => {
    const plain: MessageAttachment = { assetId: 'v-x', name: 'a.csv', mime: 'text/csv', size: 3 };
    expect(buildAttachmentMeta([plain])['v-x']).toEqual({
      mime: 'text/csv',
      name: 'a.csv',
      size: 3,
    });
    expect(buildAttachmentExt([plain]).attachment_meta[0]).toEqual(plain);
  });

  it.each([
    ['negative', { page_count: -1, thumb_w: 580, thumb_h: 751 }, { thumbW: 580, thumbH: 751 }],
    ['fraction', { page_count: 2, thumb_w: 580.5, thumb_h: 751 }, {}],
    ['zero', { page_count: 2, thumb_w: 0, thumb_h: 751 }, {}],
    ['strings', { page_count: '2', thumb_w: '580', thumb_h: '751' }, {}],
    ['half a size', { page_count: 2, thumb_w: 580 }, {}],
  ])('parseAttachmentMeta drops %s values', (_label, extra, kept) => {
    const [parsed] = parseAttachmentMeta(
      { v1: { mime: 'application/pdf', name: 'a.pdf', size: 1, ...extra } },
      ['v1'],
    );
    expect(parsed).toEqual({
      assetId: 'v1',
      mime: 'application/pdf',
      name: 'a.pdf',
      size: 1,
      ...kept,
    });
  });

  it('parseAttachments drops invalid values the same way', () => {
    const [parsed] = parseAttachments({
      attachment_meta: [
        {
          assetId: 'v1',
          name: 'a.pdf',
          mime: 'application/pdf',
          pageCount: 0,
          thumbW: 'x',
          thumbH: 9,
        },
      ],
    });
    expect(parsed).toEqual({ assetId: 'v1', name: 'a.pdf', mime: 'application/pdf' });
  });

  it('the meta of a fresh upload comes from the Worker-stored thumbnail of its version', async () => {
    const params = {
      file: new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' }),
      workspaceId: 'ws',
      origin: 'chat',
      token: 'tok',
      endpoint: 'https://upload',
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              asset: { assetId: 'a', versionId: 'v-fresh', reused: false },
              thumbnail: { width: 580, height: 751, page_count: 4 },
            }),
            { status: 201 },
          ),
      ),
    } satisfies ChatUploadParams;
    const result = await uploadChatAttachment(params);
    expect(result).toEqual({
      ok: true,
      reused: false,
      versionId: 'v-fresh',
      thumbnail: { width: 580, height: 751, pageCount: 4 },
    });
    // The outbox fills only the version id; the record-time meta still has the thumbnail.
    const sent: MessageAttachment = {
      assetId: 'v-fresh',
      name: 'deck.pdf',
      mime: 'application/pdf',
    };
    expect(thumbnailMetaOf(sent)).toEqual({ thumbW: 580, thumbH: 751, pageCount: 4 });
    expect(buildAttachmentMeta([sent])['v-fresh']).toMatchObject({
      thumb_w: 580,
      thumb_h: 751,
      page_count: 4,
    });
  });

  it('rememberThumbnail ignores an empty version id or a bad size', () => {
    rememberThumbnail('', { width: 1, height: 1 });
    rememberThumbnail('v-bad', { width: 0, height: 10 });
    expect(thumbnailMetaOf({ assetId: 'v-bad', name: '', mime: '' })).toBe(null);
  });
});
