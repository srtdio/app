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

function render(versionId: string): void {
  act(() => {
    root.render(
      <PreviewBody
        platform="instagram"
        format="single_image"
        caption="Draft"
        handle="Kite"
        firstMedia={photo(versionId)}
        localUrl="blob:local-photo"
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
});
