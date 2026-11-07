// @vitest-environment jsdom
// The viewer's details are the back bar's title ("{sender} · {time}") for
// every caller that passes details; "Show in chat" sits in the bottom bar
// only when the caller passes onShowInChat, and reports the shown index.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ImageLightbox,
  lightboxTitle,
  SHOW_IN_CHAT_LABEL,
  type ImageLightboxProps,
} from '@/components/ui/ImageLightbox';
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

function dialog(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error('no dialog');
  return el;
}

describe('ImageLightbox details (D3: the back bar title)', () => {
  it('renders "{sender} · {time}" as the back bar title, above the image pane', () => {
    mount({ details: { sender: 'Maya', time: '23 Oct' } });
    const title = dialog().querySelector('[data-lightbox-back-bar] [data-lightbox-title]');
    expect(title?.textContent).toBe('Maya · 23 Oct');
    const pane = dialog().querySelector('[data-lightbox-pane]');
    if (title === null || pane === null) throw new Error('missing title or pane');
    expect(title.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The two-line top-centre block is gone: the title carries it.
    expect(dialog().querySelector('[data-lightbox-details]')).toBeNull();
  });

  it('no details: the image name is the title', () => {
    mount();
    const title = dialog().querySelector('[data-lightbox-title]');
    expect(title?.textContent).toBe('2.jpg');
  });

  it("the caller's backBar title wins over the details", () => {
    mount({ details: { sender: 'Maya', time: '23 Oct' }, backBar: { title: 'Sam · 2h' } });
    expect(dialog().querySelector('[data-lightbox-title]')?.textContent).toBe('Sam · 2h');
  });
});

describe('lightboxTitle (pure)', () => {
  it('override, then sender · time, then the name', () => {
    expect(lightboxTitle('T', { sender: 'Maya', time: '2h' }, 'a.jpg')).toBe('T');
    expect(lightboxTitle(undefined, { sender: 'Maya', time: '2h' }, 'a.jpg')).toBe('Maya · 2h');
    expect(lightboxTitle(undefined, { sender: 'Maya', time: '' }, 'a.jpg')).toBe('Maya');
    expect(lightboxTitle(undefined, { sender: '', time: '2h' }, 'a.jpg')).toBe('2h');
    expect(lightboxTitle(undefined, { sender: '', time: '' }, 'a.jpg')).toBe('a.jpg');
    expect(lightboxTitle('', undefined, 'a.jpg')).toBe('a.jpg');
  });
});

describe('ImageLightbox Show in chat', () => {
  it('without onShowInChat there is no button', () => {
    mount({ details: { sender: 'Maya', time: '2:14 PM' } });
    expect(dialog().querySelector('[data-show-in-chat]')).toBeNull();
    expect(dialog().textContent).not.toContain(SHOW_IN_CHAT_LABEL);
  });

  it('with onShowInChat the button shows and reports the current index', () => {
    const onShowInChat = vi.fn();
    mount({ details: { sender: 'Maya', time: '2:14 PM' }, onShowInChat });
    const button = dialog().querySelector<HTMLButtonElement>('[data-show-in-chat]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe(SHOW_IN_CHAT_LABEL);
    expect(SHOW_IN_CHAT_LABEL).toBe('Show in chat');
    // 44 tall: the shared Button.
    expect(button?.className).toContain('h-11');
    act(() => button?.click());
    expect(onShowInChat).toHaveBeenCalledTimes(1);
    expect(onShowInChat).toHaveBeenCalledWith(1);
  });
});
