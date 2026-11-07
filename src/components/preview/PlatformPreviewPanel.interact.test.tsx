// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GalleryItem } from '@srtdio/posts';
import {
  PlatformPreviewPanel,
  PreviewBody,
  type PreviewBodyProps,
} from '@/components/preview/PlatformPreviewPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function media(id: string, over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    assetAttachmentId: id,
    assetVersionId: `v-${id}`,
    assetId: `a-${id}`,
    position: 0,
    filename: `${id}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
    ...over,
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

function render(props: Partial<PreviewBodyProps> = {}): void {
  act(() => {
    root.render(
      <PreviewBody
        platform="instagram"
        format="single_image"
        caption="Draft"
        handle="Kite"
        firstMedia={media('a')}
        localUrl="blob:a"
        {...props}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Show cut', () => {
  it('toggles the shaded strips on the same media', () => {
    // A 9:16 photo in Instagram's 3:4 feed frame: 25% cut from top and bottom.
    render({ firstMedia: media('a', { width: 1080, height: 1920 }) });
    expect(host.textContent).toContain('Instagram cuts 25% from top and bottom');
    const toggle = button('Show cut');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelectorAll('[data-cut-strip]')).toHaveLength(0);

    click(toggle);
    expect(button('Show cut').getAttribute('aria-pressed')).toBe('true');
    const strips = Array.from(host.querySelectorAll('[data-cut-strip]')).map((s) =>
      s.getAttribute('data-cut-strip'),
    );
    expect(strips).toEqual(['top', 'bottom']);
    // The same file, shown whole inside the frame.
    const box = host.querySelector('[data-preview-cut-box]');
    expect(box?.querySelector('img')?.getAttribute('src')).toBe('blob:a');

    click(button('Show cut'));
    expect(button('Show cut').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelectorAll('[data-cut-strip]')).toHaveLength(0);
  });

  it('shades the sides of a wide photo', () => {
    render({ platform: 'linkedin', firstMedia: media('a', { width: 3000, height: 1000 }) });
    click(button('Show cut'));
    const strips = Array.from(host.querySelectorAll('[data-cut-strip]')).map((s) =>
      s.getAttribute('data-cut-strip'),
    );
    expect(strips).toEqual(['left', 'right']);
  });
});

describe('placement chips', () => {
  it('a plain Instagram video switches between Feed, Reel and Story', () => {
    render({
      format: 'video',
      firstMedia: media('v', { kind: 'video', mimeType: 'video/mp4', width: 1080, height: 1920 }),
      localUrl: 'blob:v',
    });
    const figure = (): string => host.querySelector('figure')?.getAttribute('aria-label') ?? '';
    expect(figure()).toBe('Feed preview');
    expect(button('Feed').getAttribute('aria-pressed')).toBe('true');

    click(button('Reel'));
    expect(figure()).toBe('Full-screen preview');
    expect(button('Reel').getAttribute('aria-pressed')).toBe('true');
    expect(button('Feed').getAttribute('aria-pressed')).toBe('false');

    click(button('Story'));
    expect(figure()).toBe('Story preview');

    click(button('Feed'));
    expect(figure()).toBe('Feed preview');
  });

  it('a Reel has no chips', () => {
    render({
      format: 'reel',
      firstMedia: media('v', { kind: 'video', mimeType: 'video/mp4' }),
      localUrl: 'blob:v',
    });
    expect(host.querySelector('[aria-label="Placement"]')).toBeNull();
  });
});

describe('carousel', () => {
  it('swipes every slide and the pill follows: "{i} / {n}"', () => {
    const slides = ['a', 'b', 'c'].map((id) => ({ item: media(id), localUrl: `blob:${id}` }));
    render({ format: 'carousel', firstMedia: slides[0]?.item ?? null, slides });
    const track = host.querySelector<HTMLElement>('[data-preview-track]');
    if (track === null) throw new Error('no track');
    expect(track.querySelectorAll('img')).toHaveLength(3);
    const pill = (): string => host.querySelector('[data-preview-pill]')?.textContent ?? '';
    expect(pill()).toBe('1 / 3');

    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(track, 'scrollLeft', { configurable: true, value: 600 });
    act(() => {
      track.dispatchEvent(new Event('scroll'));
    });
    expect(pill()).toBe('3 / 3');
  });

  it('one photo draws no pill', () => {
    render({ format: 'carousel' });
    expect(host.querySelector('[data-preview-pill]')).toBeNull();
  });
});

describe('the phone page', () => {
  it('opens full screen with "<" and "{Platform} preview", no X', () => {
    act(() => {
      root.render(
        <PlatformPreviewPanel
          open
          onClose={() => undefined}
          platform="threads"
          format="text"
          caption="Hello"
          handle="Kite"
          firstMedia={null}
        />,
      );
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Threads preview');
    expect(dialog?.getAttribute('data-preview-panel')).toBe('page');
    expect(dialog?.querySelector('h1')?.textContent).toBe('Threads preview');
    expect(dialog?.querySelector('button[aria-label="Back"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Close preview"]')).toBeNull();
    expect(dialog?.querySelector('[data-preview-chrome="feed-threads"]')).not.toBeNull();
  });
});
