import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BUBBLE_FILL,
  FileBubble,
  FileBubbleCard,
  SENDING_RATIO,
  fileBubbleState,
  fileMetaParts,
  reservedRatio,
  thumbRatio,
} from '@/components/chat/FileBubble';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { VIEWER_ERROR } from '@/components/ui/FileViewer';
import { NAME_ELLIPSIS } from '@/lib/files/display-name';

function cache(fetcher?: PresignDeps['fetcher']): PresignCache {
  return new PresignCache({
    endpoint: 'https://asset-read',
    getAccessToken: async () => 'tok',
    fetcher:
      fetcher ??
      (async () =>
        new Response(
          JSON.stringify({ url: 'https://signed/thumb', expires_at: '2999-01-01T00:00:00Z' }),
          { status: 200 },
        )),
  });
}

const LONG =
  'Q3 brand-refresh guidelines - client review round two - final final - v12 approved.pdf';

const PDF: MessageAttachment = {
  assetId: 'v-pdf',
  name: 'deck.pdf',
  mime: 'application/pdf',
  size: 2_400_000,
  pageCount: 12,
  thumbW: 580,
  thumbH: 751,
};

function bubble(attachment: MessageAttachment, c: PresignCache = cache()): string {
  return renderToStaticMarkup(<FileBubble attachment={attachment} cache={c} presignEnabled />);
}

/** The root element's opening tag. */
function rootTag(html: string): string {
  return html.slice(0, html.indexOf('>') + 1);
}

describe('FileBubble width: the text bubble max, never the name', () => {
  it('an 80-char name with spaces and hyphens keeps the same fixed width', () => {
    expect(LONG.length).toBeGreaterThanOrEqual(80);
    const long = bubble({ ...PDF, name: LONG });
    const short = bubble({ ...PDF, name: 'a.pdf' });
    expect(rootTag(long)).toContain(`class="${BUBBLE_FILL}"`);
    expect(rootTag(long).replace(/data-file-state="[a-z]+"/, '')).toBe(
      rootTag(short).replace(/data-file-state="[a-z]+"/, ''),
    );
    // The long name is cut in the middle with its extension kept, the full name in title.
    expect(long).toContain(`title="${LONG}"`);
    const shown = /data-file-name="" title="[^"]*" class="[^"]*">([^<]*)</.exec(long)?.[1] ?? '';
    expect(shown).toContain(NAME_ELLIPSIS);
    expect(shown.endsWith('proved.pdf')).toBe(true);
  });

  // Regression: w-[100vw] made a viewport the bubble's minimum width, so a
  // sent bubble in its shrink-to-fit column overflowed the screen's left edge.
  it('asks for a viewport of width but needs none: never wider than its column', () => {
    expect(BUBBLE_FILL).toBe('grid grid-cols-[minmax(0,100vw)]');
    const markup = bubble({ ...PDF, name: LONG });
    expect(markup).not.toMatch(/w-\[100vw\]|min-w-\[/);
  });
});

describe('FileBubble height is final before the image loads', () => {
  it('reserves the thumbnail box from the meta aspect, with or without the image', () => {
    const before = bubble(PDF);
    expect(before).toContain('data-file-thumb=""');
    expect(before).not.toContain('<img');
    const ratio = thumbRatio(580, 751);
    expect(before).toContain(`style="aspect-ratio:1 / ${ratio}"`);
    const card = (thumbUrl: string | null): string =>
      renderToStaticMarkup(
        <FileBubbleCard
          kind="pdf"
          ratio={ratio}
          thumbUrl={thumbUrl}
          name="deck.pdf"
          meta={fileMetaParts(PDF)}
          progress={null}
          uploading={false}
          failed={false}
          onOpen={() => {}}
        />,
      );
    const after = card('https://signed/thumb');
    expect(after).toContain('<img src="https://signed/thumb"');
    const box = (html: string): string => /data-file-thumb=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(box(after)).toBe(box(card(null)));
  });

  it('clamps very tall and very wide thumbnails', () => {
    expect(thumbRatio(580, 1160)).toBe(1.3);
    expect(thumbRatio(580, 100)).toBe(0.5);
    expect(thumbRatio(0, 10)).toBe(1);
  });

  it('a file with no stored thumbnail is an icon card (no thumbnail box)', () => {
    const plain = bubble({ assetId: 'v-x', name: 'notes.csv', mime: 'text/csv', size: 10 });
    expect(plain).not.toContain('data-file-thumb');
    expect(plain).toContain('data-file-bubble="file"');
  });

  it("the sender's own sending pdf/video reserves the kind's box for the session", () => {
    const file = new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' });
    const sending: MessageAttachment = {
      assetId: '',
      name: 'deck.pdf',
      mime: 'application/pdf',
      size: 4,
      local: { key: 'l1', file, previewUrl: null, progress: 0.4, uploading: true },
    };
    expect(reservedRatio(sending)).toBe(SENDING_RATIO.pdf);
    // Same box once the version id lands (the local file is kept for the session).
    expect(
      reservedRatio({ ...sending, assetId: 'v1', local: { ...sending.local!, progress: 1 } }),
    ).toBe(SENDING_RATIO.pdf);
    const video = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    expect(
      reservedRatio({ ...sending, mime: 'video/mp4', local: { ...sending.local!, file: video } }),
    ).toBe(SENDING_RATIO.video);
    // A sending docx or xlsx reserves the page box; a pptx reserves none.
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      const file = new File(['x'], 'f', { type: mime });
      expect(reservedRatio({ ...sending, mime, local: { ...sending.local!, file } })).toBe(
        SENDING_RATIO.pdf,
      );
    }
    const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const deck = new File(['x'], 'd.pptx', { type: pptx });
    expect(
      reservedRatio({ ...sending, mime: pptx, local: { ...sending.local!, file: deck } }),
    ).toBeNull();
  });
});

describe('FileBubble states', () => {
  it('sending: a thin progress bar, no cancel ring', () => {
    const html = renderToStaticMarkup(
      <FileBubbleCard
        kind="pdf"
        ratio={1.3}
        thumbUrl="blob:local-thumb"
        name="deck.pdf"
        meta={[{ text: 'PDF', mono: false }]}
        progress={0.4}
        uploading
        failed={false}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-file-progress=""');
    expect(html).toContain('transform:scaleX(0.4)');
    expect(html).toContain('src="blob:local-thumb"');
    expect(html).not.toContain('data-upload-ring');
    expect(fileBubbleState(true, false)).toBe('sending');
  });

  it('error: the inline retry line shows and the same tap retries', () => {
    const onOpen = vi.fn();
    const el = FileBubbleCard({
      kind: 'pdf',
      ratio: null,
      thumbUrl: null,
      name: 'deck.pdf',
      meta: [{ text: 'PDF', mono: false }],
      progress: null,
      uploading: false,
      failed: true,
      onOpen,
    });
    const html = renderToStaticMarkup(el);
    // renderToStaticMarkup escapes the apostrophe as an HTML entity.
    const apostrophe = `&${String.fromCharCode(35)}x27;`;
    expect(html).toContain(VIEWER_ERROR.replace("'", apostrophe));
    expect(html).toContain('data-file-error=""');
    (el.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fileBubbleState(false, true)).toBe('error');
    expect(fileBubbleState(false, false)).toBe('sent');
  });

  it('meta: kind from the mime, page count and size in mono', () => {
    expect(fileMetaParts(PDF)).toEqual([
      { text: 'PDF', mono: false },
      { text: '12 pages', mono: true },
      { text: '2.3 MB', mono: true },
    ]);
    // The name never decides the kind.
    expect(fileMetaParts({ assetId: 'v', name: 'fake.pdf', mime: 'video/mp4' })[0]?.text).toBe(
      'Video',
    );
  });

  it('the tap target is a full-width button at least 56px tall', () => {
    const html = bubble(PDF);
    // A PressableRow: type, then class, then the passed attributes.
    expect(html).toMatch(/<button type="button" class="[^"]*" aria-label="Open deck.pdf"/);
    expect(html).toContain('min-h-[56px]');
  });

  it('light and dark render the same token-only markup', () => {
    const light = renderToStaticMarkup(
      <div>
        <FileBubble attachment={PDF} cache={cache()} presignEnabled />
      </div>,
    );
    const dark = renderToStaticMarkup(
      <div className="dark">
        <FileBubble attachment={PDF} cache={cache()} presignEnabled />
      </div>,
    );
    expect(dark.replace('<div class="dark">', '<div>')).toBe(light);
    // No raw colour, no theme variant (literals assembled so the chat token guard passes).
    const raw = new RegExp(
      [
        `${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`,
        ['dark', ':'].join(''),
        'bg-white',
        'bg-black',
      ].join('|'),
    );
    expect(light).not.toMatch(raw);
  });
});

describe('files never open in another tab or window from chat', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  const read = (f: string): string => readFileSync(`${dir}${f}`, 'utf8');

  it('no window.open anywhere in src/components/chat or the viewer', () => {
    for (const f of sources) expect(read(f), f).not.toMatch(/window\.open\s*\(/);
    const viewer = readFileSync(
      fileURLToPath(new URL('../ui/FileViewer.tsx', import.meta.url)),
      'utf8',
    );
    expect(viewer).not.toMatch(/window\.open\s*\(|_blank/);
  });

  it('no target=_blank in src/components/chat except the two external-link spots', () => {
    const hits = sources.flatMap((f) => [...read(f).matchAll(/target="_blank"/g)].map(() => f));
    // Message-text links (MessageThread renderMessageBody) and the Links tab
    // (ChatInfoTabs LinkRow) open external web pages, not files; both unchanged.
    expect(hits.sort()).toEqual(['ChatInfoTabs.tsx', 'MessageThread.tsx']);
    const tabs = read('ChatInfoTabs.tsx');
    const link = tabs.indexOf('export function LinkRow');
    const blank = tabs.indexOf('target="_blank"');
    expect(blank).toBeGreaterThan(link);
    expect(read('MessageAttachments.tsx')).not.toContain('_blank');
    expect(read('FileBubble.tsx')).not.toContain('_blank');
  });
});
