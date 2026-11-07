import { describe, expect, it } from 'vitest';
import {
  attachmentSummary,
  attachmentSummaryText,
  formatSummaryDuration,
  replyPreview,
  summaryIconOfLine,
} from '@/lib/chat/thread';
import { previewText } from '@/lib/chat/chat-store';
import type { MessageAttachment } from '@/lib/chat/attachments';

const voice: MessageAttachment = {
  assetId: 'v1',
  name: 'voice-note.webm',
  mime: 'audio/webm',
  durationMs: 67_000,
};
const img = (id: string): MessageAttachment => ({ assetId: id, name: 'p.jpg', mime: 'image/jpeg' });
const pdf: MessageAttachment = {
  assetId: 'f1',
  name: 'Q3 brief final.pdf',
  mime: 'application/pdf',
};
const video: MessageAttachment = { assetId: 'm1', name: 'clip.mp4', mime: 'video/mp4' };

describe('attachmentSummary', () => {
  it('voice note: mic, "Voice message" and m:ss from duration_ms', () => {
    expect(attachmentSummary({ attachments: [voice] })).toEqual({
      icon: 'mic',
      label: 'Voice message',
      duration: '1:07',
    });
  });

  it('voice note with no recorded length: no duration', () => {
    expect(
      attachmentSummary({ attachments: [{ assetId: 'v2', name: 'n.webm', mime: 'audio/webm' }] }),
    ).toEqual({
      icon: 'mic',
      label: 'Voice message',
    });
  });

  it('one image: camera, "Photo", first image thumbnail', () => {
    expect(attachmentSummary({ attachments: [img('a')] })).toEqual({
      icon: 'camera',
      label: 'Photo',
      thumbAssetVersionId: 'a',
    });
  });

  it('album: "N photos", thumbnail of the first image', () => {
    expect(attachmentSummary({ attachments: [img('a'), img('b'), img('c')] })).toMatchObject({
      label: '3 photos',
      thumbAssetVersionId: 'a',
    });
  });

  it('own unsent image: the local preview is the thumbnail', () => {
    const local: MessageAttachment = {
      ...img(''),
      local: { key: 'k', file: null, previewUrl: 'blob:x', progress: 0.2 },
    };
    expect(attachmentSummary({ attachments: [local] })).toEqual({
      icon: 'camera',
      label: 'Photo',
      thumbLocalUrl: 'blob:x',
    });
  });

  it('video: video icon + "Video"', () => {
    expect(attachmentSummary({ attachments: [video] })).toEqual({ icon: 'video', label: 'Video' });
  });

  it('other file: file icon + the file name', () => {
    expect(attachmentSummary({ attachments: [pdf] })).toEqual({
      icon: 'file',
      label: 'Q3 brief final.pdf',
    });
  });

  it('no attachments: null', () => {
    expect(attachmentSummary({ attachments: [] })).toBeNull();
  });

  it('text form and duration format', () => {
    expect(attachmentSummaryText({ icon: 'mic', label: 'Voice message', duration: '0:07' })).toBe(
      'Voice message (0:07)',
    );
    expect(formatSummaryDuration(7_400)).toBe('0:07');
    expect(formatSummaryDuration(725_000)).toBe('12:05');
    expect(formatSummaryDuration(Number.NaN)).toBe('0:00');
  });
});

describe('one summary everywhere', () => {
  const base = { body: '', sharedPostIds: [], sharedBriefIds: [] };

  it('replyPreview never says "Attachment"', () => {
    expect(replyPreview({ ...base, attachments: [voice] })).toBe('Voice message (1:07)');
    expect(replyPreview({ ...base, attachments: [img('a'), img('b')] })).toBe('2 photos');
    expect(replyPreview({ ...base, attachments: [pdf] })).toBe('Q3 brief final.pdf');
    expect(replyPreview({ ...base, body: 'look', attachments: [img('a')] })).toBe('look');
  });

  it('chat list line from kinds: Photo / N photos / Voice message / File', () => {
    expect(previewText({ body: '', hasAttachments: true, attachmentKinds: ['image'] })).toBe(
      'Photo',
    );
    expect(
      previewText({ body: '', hasAttachments: true, attachmentKinds: ['image', 'image'] }),
    ).toBe('2 photos');
    expect(previewText({ body: '', hasAttachments: true, attachmentKinds: ['audio'] })).toBe(
      'Voice message',
    );
    expect(previewText({ body: '', hasAttachments: true, attachmentKinds: ['file'] })).toBe('File');
  });

  it('summaryIconOfLine: the glyph for a bare summary line only', () => {
    expect(summaryIconOfLine('Photo')).toBe('camera');
    expect(summaryIconOfLine('12 photos')).toBe('camera');
    expect(summaryIconOfLine('Voice message')).toBe('mic');
    expect(summaryIconOfLine('Voice message (0:07)')).toBe('mic');
    expect(summaryIconOfLine('Video')).toBe('video');
    expect(summaryIconOfLine('File')).toBe('file');
    expect(summaryIconOfLine('Photo of the launch')).toBeNull();
    expect(summaryIconOfLine('hello')).toBeNull();
  });
});
