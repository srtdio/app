import { describe, expect, it, vi } from 'vitest';

// asset-upload is mocked so the chat upload command is asserted to reuse the
// existing pipeline (file + workspace_id) without any network.
const { uploadAssetFile } = vi.hoisted(() => ({ uploadAssetFile: vi.fn() }));
vi.mock('@/lib/asset-upload', () => ({
  uploadAssetFile,
  UPLOAD_ACCEPT: 'image/png,application/pdf',
}));

import {
  buildAttachmentExt,
  canSendAttachmentMessage,
  classifyAttachment,
  parseAttachments,
  toMessageAttachment,
  uniqueAssetIds,
  uploadChatAttachment,
  type MessageAttachment,
} from '@/lib/chat/attachments';

function fakeFile(name: string, type: string): File {
  return { name, type } as unknown as File;
}

describe('uploadChatAttachment', () => {
  it('uploads through the existing asset-upload path with {file, workspace_id} and collects the id', async () => {
    uploadAssetFile.mockResolvedValueOnce({ ok: true, reused: false, assetId: 'ver-1' });
    const file = fakeFile('photo.png', 'image/png');
    const fetcher = vi.fn();

    const outcome = await uploadChatAttachment({
      file,
      workspaceId: 'ws-1',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher,
    });

    expect(uploadAssetFile).toHaveBeenCalledWith(file, {
      endpoint: 'https://upload',
      token: 'jwt',
      workspaceId: 'ws-1',
      filename: 'photo.png',
      fetcher,
    });
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'ver-1' });
  });

  it('surfaces an upload failure as a Result and never throws', async () => {
    uploadAssetFile.mockResolvedValueOnce({
      ok: false,
      message: 'Upload failed. Check your connection and retry',
    });
    const outcome = await uploadChatAttachment({
      file: fakeFile('a.pdf', 'application/pdf'),
      workspaceId: 'ws-1',
      token: 'jwt',
      endpoint: 'https://upload',
      fetcher: vi.fn(),
    });
    expect(outcome).toEqual({
      ok: false,
      message: 'Upload failed. Check your connection and retry',
    });
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

describe('uniqueAssetIds', () => {
  it('dedupes ids and drops empties so the renderer never presigns the same id twice', () => {
    expect(
      uniqueAssetIds([
        { assetId: 'a1', name: '', mime: '' },
        { assetId: 'a1', name: '', mime: '' },
        { assetId: '', name: '', mime: '' },
        { assetId: 'a2', name: '', mime: '' },
      ]),
    ).toEqual(['a1', 'a2']);
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

  it('allows attachments-only and text-only', () => {
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
  it('builds the attachment from the file and the uploaded id', () => {
    expect(toMessageAttachment(fakeFile('doc.pdf', 'application/pdf'), 'ver-9')).toEqual({
      assetId: 'ver-9',
      name: 'doc.pdf',
      mime: 'application/pdf',
    });
  });
});
