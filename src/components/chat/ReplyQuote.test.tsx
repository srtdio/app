import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplyQuoteBox, quoteMedia } from '@/components/chat/ReplyQuote';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { MessageAttachment } from '@/lib/chat/attachments';

const voice: MessageAttachment = {
  assetId: 'v1',
  name: 'voice-note.webm',
  mime: 'audio/webm',
  durationMs: 7_000,
};
const img: MessageAttachment = { assetId: 'img-1', name: 'p.jpg', mime: 'image/jpeg' };
const pdf: MessageAttachment = { assetId: 'f1', name: 'brief.pdf', mime: 'application/pdf' };

function cache(): PresignCache {
  const deps: PresignDeps = {
    endpoint: 'https://asset-read',
    getAccessToken: async () => 'token',
    fetcher: async () => new Response('{}', { status: 500 }),
  };
  return new PresignCache(deps);
}

describe('quoteMedia', () => {
  it('null when the quoted message is not loaded, deleted, or plain text', () => {
    expect(quoteMedia(undefined)).toBeNull();
    expect(quoteMedia({ body: '', attachments: [voice], deleted: true })).toBeNull();
    expect(quoteMedia({ body: 'hi', attachments: [] })).toBeNull();
    expect(quoteMedia({ body: 'see file', attachments: [pdf] })).toBeNull();
  });

  it('media-only: the label replaces the line; body + image keeps the text with the thumbnail', () => {
    expect(quoteMedia({ body: '', attachments: [voice] })).toMatchObject({ showLabel: true });
    expect(quoteMedia({ body: 'look', attachments: [img] })).toMatchObject({
      showLabel: false,
      summary: { thumbAssetVersionId: 'img-1' },
    });
  });
});

describe('ReplyQuoteBox media', () => {
  const source = { cache: cache(), presignEnabled: true };

  it('voice: mic glyph, "Voice message" and the length, never "Attachment"', () => {
    const html = renderToStaticMarkup(
      <ReplyQuoteBox
        author="Asha"
        preview="Attachment"
        media={quoteMedia({ body: '', attachments: [voice] })}
        thumbSource={source}
        onJump={() => {}}
      />,
    );
    expect(html).toContain('data-quote-media="mic"');
    expect(html).toContain('Voice message');
    expect(html).toContain('0:07');
    expect(html).not.toContain('Attachment');
    expect(html).not.toContain('data-quote-thumb');
  });

  it('photo: camera glyph, "Photo" and a 36px thumbnail box from the first frame', () => {
    const html = renderToStaticMarkup(
      <ReplyQuoteBox
        author="Asha"
        preview="Attachment"
        media={quoteMedia({ body: '', attachments: [img] })}
        thumbSource={source}
      />,
    );
    expect(html).toContain('data-quote-media="camera"');
    expect(html).toContain('Photo');
    expect(html).toContain('data-quote-thumb');
    expect(html).toContain('h-9 w-9');
    expect(html).toContain('rounded-lg');
  });

  it('file: file glyph + name with an ellipsis', () => {
    const html = renderToStaticMarkup(
      <ReplyQuoteBox
        author="Asha"
        preview="x"
        media={quoteMedia({ body: '', attachments: [pdf] })}
      />,
    );
    expect(html).toContain('data-quote-media="file"');
    expect(html).toContain('brief.pdf');
    expect(html).toContain('truncate');
  });

  it('body + image: the body text with the thumbnail', () => {
    const html = renderToStaticMarkup(
      <ReplyQuoteBox
        author="Asha"
        preview="look at this"
        media={quoteMedia({ body: 'look at this', attachments: [img] })}
        thumbSource={source}
      />,
    );
    expect(html).toContain('look at this');
    expect(html).not.toContain('data-quote-media');
    expect(html).toContain('data-quote-thumb');
  });

  it('unloaded quote: the stored preview text', () => {
    const html = renderToStaticMarkup(
      <ReplyQuoteBox author="Asha" preview="Voice message (0:07)" />,
    );
    expect(html).toContain('Voice message (0:07)');
    expect(html).not.toContain('data-quote-media');
  });
});
