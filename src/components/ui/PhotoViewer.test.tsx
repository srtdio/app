// @vitest-environment jsdom
// The photo-only viewer (inside a DM, the chat list's People cards): the
// person's photo large with its initials fallback, the full name, an X; it
// closes on the X, Esc, a tap outside the photo and Back, never on the photo
// itself, and hands focus back to what was tapped. Nothing to message here.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ onBack: null as (() => void) | null }));

vi.mock('@/lib/back-guard', () => ({
  useBackGuard: (opts: { active: boolean; onBack: () => void }) => {
    h.onBack = opts.active ? opts.onBack : null;
    return { release: () => {} };
  },
}));

import { PhotoViewer, PHOTO_SCALE_CLASS } from '@/components/ui/PhotoViewer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEO = '0190a000-0000-7000-8000-000000000003';

let root: Root | null = null;
let trigger: HTMLButtonElement;
let onClose: ReturnType<typeof vi.fn>;

async function mount(avatarUrl: string | null = 'https://x.test/leo.png'): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PhotoViewer
        userId={LEO}
        name="Leo Martins"
        avatarUrl={avatarUrl}
        trigger={trigger}
        onClose={onClose}
      />,
    );
  });
}

const viewer = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-photo-viewer="${LEO}"]`);

beforeEach(() => {
  trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();
  onClose = vi.fn();
  h.onBack = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PhotoViewer', () => {
  it('shows the photo large, the full name and an X; no message controls', async () => {
    await mount();
    const v = viewer();
    expect(v?.getAttribute('role')).toBe('dialog');
    expect(v?.getAttribute('aria-modal')).toBe('true');
    const photo = v?.querySelector('[data-photo-viewer-photo]');
    expect(photo?.className).toContain(PHOTO_SCALE_CLASS);
    expect(photo?.querySelector('img')?.getAttribute('src')).toBe('https://x.test/leo.png');
    expect(photo?.querySelector('[data-avatar-role="profile"]')).not.toBeNull();
    expect(v?.textContent).toContain('Leo Martins');
    expect(v?.querySelector('[data-photo-viewer-close]')?.getAttribute('aria-label')).toBe('Close');
    expect(v?.querySelector('textarea, input')).toBeNull();
    expect(v?.querySelectorAll('button')).toHaveLength(1);
    expect(v?.querySelector('[data-person-message]')).toBeNull();
  });

  it('without a photo shows the initials fallback', async () => {
    await mount(null);
    const photo = viewer()?.querySelector('[data-photo-viewer-photo]');
    expect(photo?.querySelector('img')).toBeNull();
    expect(photo?.textContent).toBe('LM');
  });

  it('the X closes it', async () => {
    await mount();
    await act(async () => {
      viewer()?.querySelector<HTMLButtonElement>('[data-photo-viewer-close]')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc closes it', async () => {
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a tap on the overlay outside the photo closes it', async () => {
    await mount();
    await act(async () => viewer()?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a tap on the photo itself does not close it', async () => {
    await mount();
    await act(async () => {
      viewer()?.querySelector<HTMLElement>('[data-photo-viewer-photo]')?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Back closes it (the back guard is active while open)', async () => {
    await mount();
    expect(h.onBack).not.toBeNull();
    await act(async () => h.onBack?.());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus moves to the X on open and back to the trigger on close', async () => {
    await mount();
    expect(document.activeElement?.hasAttribute('data-photo-viewer-close')).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(trigger);
  });
});
