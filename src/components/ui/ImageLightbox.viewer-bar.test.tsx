// @vitest-environment jsdom
// Delete for me U5: the chat home photo viewer's bottom bar. Forward and Delete
// are opt-in IconButtons (44x44), left of Download, in the overlay ink; every
// other caller (no onForward / onDelete) keeps today's bar.
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

const IMAGES = [
  { assetId: 'a1', name: '1.jpg', src: 'blob:one' },
  { assetId: 'a2', name: '2.jpg', src: 'blob:two' },
];

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(over: Partial<ImageLightboxProps> = {}): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ImageLightbox
        images={IMAGES}
        index={1}
        cache={cache}
        presignEnabled={false}
        onIndexChange={() => {}}
        onClose={() => {}}
        {...over}
      />,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
}

function bar(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="viewer-bar"]');
}

function labels(): string[] {
  return [...(bar()?.querySelectorAll('button') ?? [])].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent ?? '',
  );
}

const DETAILS = { sender: 'Maya', time: '2:14 PM' };

describe('ImageLightbox viewer bar (Forward, Delete, Download)', () => {
  it('no details and no handlers: no bar', () => {
    mount();
    expect(bar()).toBeNull();
  });

  it('details only: Download, no Forward or Delete', () => {
    mount({ details: DETAILS });
    expect(labels()).toEqual(['Download']);
  });

  it('with onForward and onDelete: Forward, then Delete, then Download', () => {
    mount({ details: DETAILS, onForward: vi.fn(), onDelete: vi.fn() });
    expect(labels()).toEqual(['Forward', 'Delete', 'Download']);
  });

  it('only the handler passed shows', () => {
    mount({ details: DETAILS, onForward: vi.fn() });
    expect(labels()).toEqual(['Forward', 'Download']);
    cleanup?.();
    cleanup = null;
    mount({ details: DETAILS, onDelete: vi.fn() });
    expect(labels()).toEqual(['Delete', 'Download']);
  });

  it('Forward and Delete report the shown index; both are 44x44 in the overlay ink', () => {
    const onForward = vi.fn();
    const onDelete = vi.fn();
    mount({ details: DETAILS, onForward, onDelete });
    const forward = bar()?.querySelector<HTMLButtonElement>('button[aria-label="Forward"]');
    const del = bar()?.querySelector<HTMLButtonElement>('button[aria-label="Delete"]');
    act(() => forward?.click());
    act(() => del?.click());
    expect(onForward).toHaveBeenCalledWith(1);
    expect(onDelete).toHaveBeenCalledWith(1);
    for (const button of [forward, del]) {
      expect(button?.className).toContain('h-11');
      expect(button?.className).toContain('w-11');
      expect(button?.className).toContain('text-overlay-fg');
    }
  });
});
