// @vitest-environment jsdom
// The thumbnail lands after the message: the card's box is sized from the
// recorded meta alone, so it is identical with and without the image, and the
// placeholder stays visible until the image has loaded (no blink).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileBubbleCard, thumbRatio } from '@/components/chat/FileBubble';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// The size the message recorded at pick time (the local thumbnail's).
const RATIO = thumbRatio(580, 751);

function render(thumbUrl: string | null): void {
  act(() => {
    root.render(
      <FileBubbleCard
        kind="pdf"
        ratio={RATIO}
        thumbUrl={thumbUrl}
        name="deck.pdf"
        meta={[{ text: 'PDF', mono: false }]}
        progress={null}
        uploading={false}
        failed={false}
        onOpen={() => {}}
      />,
    );
  });
}

const box = (): HTMLElement => host.querySelector('[data-file-thumb]') as HTMLElement;
const placeholder = (): Element | null => host.querySelector('[data-file-thumb-placeholder]');
const images = (): HTMLImageElement[] => [...box().querySelectorAll('img')];

describe('FileBubbleCard: the late thumbnail fills the same box without a blink', () => {
  it('keeps the box size identical before and after the thumbnail arrives', () => {
    render(null);
    const before = { style: box().getAttribute('style'), className: box().className };
    expect(images()).toHaveLength(0);
    expect(placeholder()).not.toBeNull();

    render('https://signed/thumb');
    expect(box().getAttribute('style')).toBe(before.style);
    expect(box().className).toBe(before.className);
  });

  it('shows the placeholder until the image has loaded, then fades the image in', () => {
    render(null);
    const boxEl = box();
    render('https://signed/thumb');
    // Same box element: nothing unmounted or remounted.
    expect(box()).toBe(boxEl);
    const [img] = images();
    expect(img?.getAttribute('data-loaded')).toBe('false');
    expect(img?.className).toContain('opacity-0');
    expect(img?.className).toContain('duration-fast');
    expect(img?.className).toContain('ease-enter');
    expect(placeholder()).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event('load'));
    });
    const [loaded] = images();
    expect(loaded).toBe(img);
    expect(loaded?.getAttribute('data-loaded')).toBe('true');
    expect(loaded?.className).toContain('opacity-100');
    expect(box()).toBe(boxEl);
  });

  it('a new URL keeps the last loaded image under it until the new one loads', () => {
    render('https://local/thumb');
    act(() => {
      images()[0]?.dispatchEvent(new Event('load'));
    });
    render('https://signed/thumb');
    const shown = images();
    expect(shown).toHaveLength(2);
    expect(shown[0]?.getAttribute('src')).toBe('https://local/thumb');
    expect(shown[1]?.getAttribute('src')).toBe('https://signed/thumb');
    expect(shown[1]?.getAttribute('data-loaded')).toBe('false');

    act(() => {
      shown[1]?.dispatchEvent(new Event('load'));
    });
    const after = images();
    expect(after).toHaveLength(1);
    expect(after[0]?.getAttribute('src')).toBe('https://signed/thumb');
    expect(after[0]?.getAttribute('data-loaded')).toBe('true');
  });
});
