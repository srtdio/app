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
  uploadChatAttachment,
  type MessageAttachment,
  type ReplyQuote,
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
    expect((form.get('file') as File).name).toBe('photo.png');
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
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({
      ok: false,
      message: 'Upload failed. Check your connection and retry',
    });
  });

  it('surfaces an upload failure as a Result and never throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));

    const outcome = await uploadChatAttachment({
      file: new File(['x'], 'a.pdf', { type: 'application/pdf' }),
      workspaceId: 'ws-1',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(outcome).toEqual({
      ok: false,
      message: 'Upload failed. Check your connection and retry',
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
});

describe('canSendAttachmentMessage', () => {
  it('blocks an empty send (no text, no attachments)', () => {
    expect(
      canSendAttachmentMessage({
        text: '   ',
        attachmentCount: 0,
        uploading: false,
        sending: false,
      }),
    ).toBe(false);
  });

  it('allows attachments-only, text-only, and shared-posts-only', () => {
    expect(
      canSendAttachmentMessage({ text: '', attachmentCount: 1, uploading: false, sending: false }),
    ).toBe(true);
    expect(
      canSendAttachmentMessage({
        text: 'hi',
        attachmentCount: 0,
        uploading: false,
        sending: false,
      }),
    ).toBe(true);
    // Shared-posts-only: no text, no attachments, but a post is queued.
    expect(
      canSendAttachmentMessage({
        text: '   ',
        attachmentCount: 0,
        sharedPostCount: 1,
        uploading: false,
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
        uploading: false,
        sending: false,
      }),
    ).toBe(false);
  });

  it('blocks while an upload is in flight or a send is settling', () => {
    expect(
      canSendAttachmentMessage({ text: 'hi', attachmentCount: 1, uploading: true, sending: false }),
    ).toBe(false);
    expect(
      canSendAttachmentMessage({ text: 'hi', attachmentCount: 1, uploading: false, sending: true }),
    ).toBe(false);
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
