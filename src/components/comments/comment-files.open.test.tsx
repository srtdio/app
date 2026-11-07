// @vitest-environment jsdom
// Every comment file opens in-app: a PDF, a docx and a photo from a comment
// open the in-app viewers with the over-the-app bar ("<" Back, name or
// "{Name} · {formatAgo}", Download), never a new tab. Chat viewers have the
// same "<" bar (D3).
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// jsdom has no Worker or canvas: the office runner and pdf.js are faked.
vi.mock('@/lib/files/office/run', () => ({ runOffice: vi.fn(async () => ({ ok: false })) }));
vi.mock('@/lib/files/thumbnail', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/files/thumbnail')>();
  return { ...actual, loadPdfJs: vi.fn(() => new Promise(() => undefined)) };
});

import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { FileBubble } from '@/components/chat/FileBubble';
import { FileViewerSheet, type FileViewerSource } from '@/components/ui/FileViewer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import {
  commentViewerTitle,
  toCommentFileAttachments,
  type CommentFile,
} from '@/components/comments/comment-files';
import { PresignCache } from '@/lib/asset-presign';
import { loadPdfJs, type PdfDocumentLike, type PdfJsLike } from '@/lib/files/thumbnail';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const cache = new PresignCache({
  endpoint: 'https://asset-read.test',
  getAccessToken: async () => 'token',
  fetcher: async () => new Response(null, { status: 500 }),
});

const FILES = new Map<string, CommentFile>([
  ['v-pdf', { name: 'Launch deck.pdf', mime: 'application/pdf', size: 2_400_000, pageCount: 12 }],
  ['v-doc', { name: 'Brief.docx', mime: DOCX, size: 48_000 }],
  ['v-img1', { name: 'one.jpg', mime: 'image/jpeg', width: 1200, height: 900 }],
  ['v-img2', { name: 'two.jpg', mime: 'image/jpeg', width: 900, height: 1200 }],
]);

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  document.body.innerHTML = '';
});

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return host;
}

function openCard(host: HTMLElement, name: string): void {
  const card = host.querySelector<HTMLButtonElement>(`button[aria-label="Open ${name}"]`);
  expect(card).not.toBeNull();
  act(() => card?.click());
}

function viewer(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-file-viewer]');
}

/** window.open, watched: nothing here may open a new tab or window. */
function spyNewTab(): { calls: unknown[] } {
  const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
  cleanups.push(() => spy.mockRestore());
  return spy.mock;
}

describe('comment files open in-app', () => {
  it('a PDF opens the in-app viewer with "<" Back, its name and Download; no new tab', () => {
    const opened = spyNewTab();
    const attachments = toCommentFileAttachments(['v-pdf'], FILES);
    const host = mount(
      <MessageAttachments attachments={attachments} cache={cache} presignEnabled />,
    );
    expect(host.textContent).toContain('Launch deck.pdf');
    openCard(host, 'Launch deck.pdf');
    const sheet = viewer();
    expect(sheet?.getAttribute('data-file-viewer')).toBe('pdf');
    const bar = sheet?.querySelector('[data-viewer-bar]');
    expect(bar?.querySelector('button[aria-label="Back"]')).not.toBeNull();
    expect(bar?.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(bar?.querySelector('button[aria-label="Download"]')).not.toBeNull();
    expect(bar?.textContent).toContain('Launch deck.pdf');
    expect(opened.calls).toHaveLength(0);
  });

  it('a docx opens the in-app office viewer with the same bar', () => {
    const opened = spyNewTab();
    const attachments = toCommentFileAttachments(['v-doc'], FILES);
    const host = mount(
      <MessageAttachments attachments={attachments} cache={cache} presignEnabled />,
    );
    openCard(host, 'Brief.docx');
    const sheet = viewer();
    expect(sheet?.getAttribute('data-file-viewer')).toBe('office');
    expect(sheet?.querySelector('[data-viewer-bar] button[aria-label="Back"]')).not.toBeNull();
    expect(sheet?.querySelector('[data-viewer-bar]')?.textContent).toContain('Brief.docx');
    expect(opened.calls).toHaveLength(0);
  });

  it('a photo opens the lightbox over its photos: "<", title, "i / n", Download', () => {
    const images = toCommentFileAttachments(['v-img1', 'v-img2'], FILES);
    const title = commentViewerTitle('Maya Rao', '2026-11-07T09:55:00Z', new Date());
    mount(
      <ImageLightbox
        images={images}
        index={1}
        cache={cache}
        presignEnabled={false}
        onIndexChange={() => {}}
        onClose={() => {}}
        backBar={{ title }}
      />,
    );
    const bar = document.body.querySelector<HTMLElement>('[data-lightbox-back-bar]');
    expect(bar).not.toBeNull();
    const labels = [...(bar?.querySelectorAll('button') ?? [])].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Back', 'Download']);
    expect(bar?.querySelector('[data-lightbox-title]')?.textContent).toBe(title);
    expect(bar?.querySelector('[data-lightbox-counter]')?.textContent).toBe('2 / 2');
    expect(document.body.querySelector('button[aria-label="Close viewer"]')).toBeNull();
    // Swipe and pinch still live on the same pane.
    expect(document.body.querySelector('[data-lightbox-pane]')).not.toBeNull();
  });

  it('a PDF in the back bar reads "Page {i} of {n}" under the name, no bottom chip', async () => {
    const doc: PdfDocumentLike = {
      numPages: 3,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 100 * scale,
          height: 130 * scale,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        cleanup: () => {},
      }),
    };
    const pdfjs: PdfJsLike = {
      getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }),
      AnnotationMode: { DISABLE: 0 },
    };
    vi.mocked(loadPdfJs).mockResolvedValueOnce(pdfjs);
    const source: FileViewerSource = {
      pdfBytes: async () => new Uint8Array([37, 80, 68, 70]),
      officeBytes: async () => null,
      videoLink: async () => ({ url: 'https://signed/v', release: () => {} }),
      downloadLink: async () => ({ url: 'https://signed/d', release: () => {} }),
      previewNow: () => null,
      preview: async () => null,
    };
    const close = (): void => {};
    mount(<FileViewerSheet name="deck.pdf" kind="pdf" source={source} onClose={close} />);
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    const line = document.body.querySelector('[data-viewer-bar-line]');
    expect(line?.textContent).toBe('Page 1 of 3');
    expect(document.body.querySelector('[data-page-counter]')).toBeNull();
  });
});

describe('chat viewers leave with "<" too (D3)', () => {
  it('a chat file opens with the Back bar, never an X', () => {
    const [pdf] = toCommentFileAttachments(['v-pdf'], FILES);
    const host = mount(<FileBubble attachment={pdf!} cache={cache} presignEnabled />);
    openCard(host, 'Launch deck.pdf');
    const bar = viewer()?.querySelector('[data-viewer-bar]');
    expect(bar?.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(bar?.querySelector('button[aria-label="Back"]')).not.toBeNull();
  });

  it('the chat lightbox has the back bar and no "Close viewer"', () => {
    const images = toCommentFileAttachments(['v-img1', 'v-img2'], FILES);
    mount(
      <ImageLightbox
        images={images}
        index={0}
        cache={cache}
        presignEnabled={false}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(document.body.querySelector('button[aria-label="Close viewer"]')).toBeNull();
    expect(document.body.querySelector('[data-lightbox-back-bar]')).not.toBeNull();
  });
});
