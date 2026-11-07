// @vitest-environment jsdom
// D3: every image viewer leaves with "<" (Back) on the leading edge of its top
// bar, never an X. The counter shows only with more than one image, and so do
// the arrows (D2: never arrows for a single photo).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ImageLightbox, type ImageLightboxProps } from '@/components/ui/ImageLightbox';
import { PresignCache } from '@/lib/asset-presign';

const cache = new PresignCache({
  endpoint: 'https://asset-read.test',
  getAccessToken: async () => 'token',
  fetcher: async () => new Response(null, { status: 500 }),
});

const TWO = [
  { assetId: 'a1', name: '1.jpg', src: 'blob:one' },
  { assetId: 'a2', name: '2.jpg', src: 'blob:two' },
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(over: Partial<ImageLightboxProps> = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onClose = over.onClose ?? (() => {});
  act(() => {
    root.render(
      <ImageLightbox
        images={TWO}
        index={0}
        cache={cache}
        presignEnabled={false}
        onIndexChange={() => {}}
        {...over}
        onClose={onClose}
      />,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error('no dialog');
  return dialog;
}

describe('ImageLightbox exit (D3)', () => {
  it('chat (details): "<" Back leads the top bar, no X anywhere', () => {
    const onClose = vi.fn();
    const dialog = mount({ details: { sender: 'Maya', time: '2h' }, onClose });
    const bar = dialog.querySelector<HTMLElement>('[data-lightbox-back-bar]');
    const first = bar?.querySelector('button');
    expect(first?.getAttribute('aria-label')).toBe('Back');
    expect(first?.querySelector('svg')).not.toBeNull();
    expect(dialog.querySelector('button[aria-label="Close viewer"]')).toBeNull();
    expect(dialog.querySelector('button[aria-label="Close"]')).toBeNull();
    act(() => first?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus starts on Back', () => {
    mount({ details: { sender: 'Maya', time: '2h' } });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Back');
  });

  it('more than one image: the "i / n" counter and the arrows', () => {
    const dialog = mount();
    expect(dialog.querySelector('[data-lightbox-counter]')?.textContent).toBe('1 / 2');
    expect(dialog.querySelector('button[aria-label="Previous image"]')).not.toBeNull();
    expect(dialog.querySelector('button[aria-label="Next image"]')).not.toBeNull();
  });

  it('one image: Back, no counter, no arrows', () => {
    const dialog = mount({ images: [TWO[0]!] });
    expect(dialog.querySelector('button[aria-label="Back"]')).not.toBeNull();
    expect(dialog.querySelector('[data-lightbox-counter]')).toBeNull();
    expect(dialog.querySelector('button[aria-label="Previous image"]')).toBeNull();
    expect(dialog.querySelector('button[aria-label="Next image"]')).toBeNull();
  });
});
