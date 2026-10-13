import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOB_RELEASE_MS, saveFromLink } from '@/lib/files/download';

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  target?: string;
  style: { display: string };
  click: () => void;
  remove: () => void;
}

function stubDocument(): FakeAnchor[] {
  const anchors: FakeAnchor[] = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn(),
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: vi.fn() },
  });
  return anchors;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saveFromLink', () => {
  it('saves through a same-window download anchor, never a new tab', async () => {
    const anchors = stubDocument();
    const ok = await saveFromLink(
      async () => ({ url: 'https://signed/a?attachment', release: () => {} }),
      'a.pdf',
    );
    expect(ok).toBe(true);
    const [anchor] = anchors;
    expect(anchor?.href).toBe('https://signed/a?attachment');
    expect(anchor?.download).toBe('a.pdf');
    expect(anchor?.target).toBeUndefined();
    expect(anchor?.click).toHaveBeenCalledOnce();
    expect(anchor?.remove).toHaveBeenCalledOnce();
  });

  it('resolves false when the link cannot be minted', async () => {
    stubDocument();
    expect(await saveFromLink(() => Promise.reject(new Error('no')), 'a.pdf')).toBe(false);
  });

  // Regression: a presigned link left a 30s timer behind on every save.
  it('leaves no timer for a presigned link', async () => {
    vi.useFakeTimers();
    stubDocument();
    await saveFromLink(async () => ({ url: 'https://signed/a', release: () => {} }), 'a.pdf');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a blob link once the save has had time to start', async () => {
    vi.useFakeTimers();
    stubDocument();
    const release = vi.fn();
    await saveFromLink(async () => ({ url: 'blob:x', release }), 'a.pdf');
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BLOB_RELEASE_MS);
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
