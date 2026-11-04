// @vitest-environment jsdom
// The viewer's details sit at the top centre (name, then the time in mono),
// for every caller that passes details; "Show in chat" sits in the bottom bar
// only when the caller passes onShowInChat, and reports the shown index.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ImageLightbox,
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

describe('ImageLightbox details', () => {
  it('renders the sender and time at the top centre, above the image pane', () => {
    mount({ details: { sender: 'Maya', time: '23 Oct, 2:14 PM' } });
    const block = dialog().querySelector('[data-lightbox-details]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('Maya');
    expect(block?.textContent).toContain('23 Oct, 2:14 PM');
    const time = [...(block?.querySelectorAll('span') ?? [])].find(
      (s) => s.textContent === '23 Oct, 2:14 PM',
    );
    expect(time?.className).toContain('font-mono');
    expect(time?.className).toContain('tabular-nums');
    // Top: it comes before the pane in document order.
    const pane = dialog().querySelector('[data-lightbox-pane]');
    if (block === null || pane === null) throw new Error('missing block or pane');
    expect(block.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no details: no details block (comments)', () => {
    mount();
    expect(dialog().querySelector('[data-lightbox-details]')).toBeNull();
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
