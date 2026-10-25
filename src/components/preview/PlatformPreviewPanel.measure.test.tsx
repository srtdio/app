// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GalleryItem } from '@srtdio/posts';
import { PreviewBody } from '@/components/preview/PlatformPreviewPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function photo(versionId: string): GalleryItem {
  return {
    assetAttachmentId: 'aa',
    assetVersionId: versionId,
    assetId: 'a1',
    position: 0,
    filename: 'photo.png',
    mimeType: 'image/png',
    kind: 'image',
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(versionId: string, localUrl = 'blob:local-photo'): void {
  act(() => {
    root.render(
      <PreviewBody
        platform="instagram"
        format="single_image"
        caption="Draft"
        handle="Kite"
        firstMedia={photo(versionId)}
        localUrl={localUrl}
      />,
    );
  });
}

/** Every preview image reports a 1080x1350 natural size and fires its load. */
function loadImages(): void {
  for (const img of Array.from(host.querySelectorAll('img'))) {
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1080 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1350 });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  }
}

describe('PreviewBody measure', () => {
  it('keeps the measure when an upload lands its version id on the same local file', () => {
    render('local-1');
    expect(host.textContent).toContain('Measuring the original.');
    loadImages();
    expect(host.textContent).not.toContain('Measuring the original.');

    // The upload finishes: a new version id, the same blob URL, no new load event.
    render('v-uploaded');
    expect(host.textContent).not.toContain('Measuring the original.');
  });

  it('measures a photo already decoded when it mounts, with no load event after', () => {
    // The composer's frame showed the same blob first, so the preview's image is
    // complete as it mounts. The reset effect used to run after the ref callback
    // and wipe the measure, and no load event came to measure it again.
    const proto = HTMLImageElement.prototype;
    const complete = Object.getOwnPropertyDescriptor(proto, 'complete');
    const naturalWidth = Object.getOwnPropertyDescriptor(proto, 'naturalWidth');
    const naturalHeight = Object.getOwnPropertyDescriptor(proto, 'naturalHeight');
    Object.defineProperty(proto, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => 1080 });
    Object.defineProperty(proto, 'naturalHeight', { configurable: true, get: () => 1350 });
    try {
      render('v-uploaded');
      expect(host.textContent).not.toContain('Measuring the original.');
      expect(host.textContent).toContain('1080 x 1350');
    } finally {
      for (const [key, desc] of [
        ['complete', complete],
        ['naturalWidth', naturalWidth],
        ['naturalHeight', naturalHeight],
      ] as const) {
        if (desc !== undefined) Object.defineProperty(proto, key, desc);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    }
  });

  it('measures again when a different file replaces the photo', () => {
    render('local-1', 'blob:first');
    loadImages();
    expect(host.textContent).not.toContain('Measuring the original.');

    render('local-2', 'blob:second');
    expect(host.textContent).toContain('Measuring the original.');
    loadImages();
    expect(host.textContent).not.toContain('Measuring the original.');
  });
});
