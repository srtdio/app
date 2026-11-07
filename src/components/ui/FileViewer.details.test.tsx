// @vitest-environment jsdom
// The FileViewer's chat extras: sender and sent time as the back bar's title
// ("{Sender} · {formatAgo}", the file name under it), and a "Show in chat"
// button in a bottom bar, each only when its props are given. Without them the
// title is the file name.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileViewerSheet,
  SHOW_IN_CHAT_LABEL,
  fileViewerDetails,
  viewerBarTitle,
  type FileViewerProps,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { formatAgo } from '@/lib/time';

vi.mock('@/lib/files/office/run', () => ({ runOffice: vi.fn() }));

const source: FileViewerSource = {
  pdfBytes: async () => new Uint8Array(),
  officeBytes: async () => null,
  videoLink: async () => ({ url: 'https://signed/v', release: () => {} }),
  downloadLink: async () => ({ url: 'https://signed/d', release: () => {} }),
  previewNow: () => null,
  preview: async () => null,
};

const AT = '2026-10-23T14:14:00.000Z';

function html(over: Partial<FileViewerProps> = {}): string {
  return renderToStaticMarkup(
    <FileViewerSheet name="clip.mp4" kind="video" source={source} onClose={() => {}} {...over} />,
  );
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('fileViewerDetails', () => {
  it('null when neither sender nor sentAt is given', () => {
    expect(fileViewerDetails(undefined, undefined)).toBeNull();
  });

  it('formats sentAt through src/lib/time.ts formatAgo (short past time)', () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(fileViewerDetails('Maya', AT, now)).toEqual({
      sender: 'Maya',
      time: formatAgo(AT, now),
    });
    expect(fileViewerDetails('Maya', AT, now)?.time).toBe('23 Oct');
  });

  it('either line alone still shows', () => {
    expect(fileViewerDetails('Maya', undefined)).toEqual({ sender: 'Maya', time: '' });
    expect(fileViewerDetails(undefined, AT)?.sender).toBe('');
  });
});

describe('FileViewer chat extras', () => {
  it('no props: the title is the file name, no Show in chat', () => {
    const out = html();
    expect(out).not.toContain('data-lightbox-details');
    expect(out).toMatch(/data-viewer-bar-title=""[^>]*>clip\.mp4</);
    expect(out).not.toContain('data-show-in-chat');
    expect(out).not.toContain(SHOW_IN_CHAT_LABEL);
  });

  it('sender and sentAt: the back bar title reads "{Sender} · {formatAgo}", the name under it', () => {
    const out = html({ sender: 'Maya', sentAt: AT });
    // formatAgo: more than 6 days back reads as the day ("23 Oct", year when off-year).
    expect(out).toMatch(/data-viewer-bar-title=""[^>]*>Maya · 23 Oct</);
    expect(out).toMatch(/data-viewer-bar-line=""[^>]*>clip\.mp4</);
    expect(out).not.toContain('data-lightbox-details');
    expect(out).toContain('aria-label="Back"');
    expect(out).not.toContain('data-show-in-chat');
  });

  it('viewerBarTitle: sender · time, either half alone, else the name', () => {
    expect(viewerBarTitle({ sender: 'Maya', time: '2h' }, 'a.pdf')).toBe('Maya · 2h');
    expect(viewerBarTitle({ sender: 'Maya', time: '' }, 'a.pdf')).toBe('Maya');
    expect(viewerBarTitle({ sender: '', time: '2h' }, 'a.pdf')).toBe('2h');
    expect(viewerBarTitle({ sender: '', time: '' }, 'a.pdf')).toBe('a.pdf');
    expect(viewerBarTitle(null, 'a.pdf')).toBe('a.pdf');
  });

  it('the video still plays in the native player', () => {
    // The renderer is unchanged: the video kind renders its own (loading) state.
    expect(html({ sender: 'Maya', sentAt: AT })).toContain('data-file-viewer="video"');
  });

  it('onShowInChat: the bottom button shows and calls back on tap', () => {
    const onShowInChat = vi.fn();
    expect(html({ onShowInChat })).toContain('data-show-in-chat');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FileViewerSheet
          name="brief.pdf"
          kind="file"
          source={source}
          onClose={() => {}}
          onShowInChat={onShowInChat}
        />,
      );
    });
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const button = host.querySelector<HTMLButtonElement>('[data-show-in-chat]');
    expect(button?.textContent).toBe(SHOW_IN_CHAT_LABEL);
    expect(button?.className).toContain('h-11');
    act(() => button?.click());
    expect(onShowInChat).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-lightbox-details]')).toBeNull();
  });
});
