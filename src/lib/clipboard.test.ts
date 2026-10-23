import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_FAILED, copyText } from '@/lib/clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('resolves true after writing the text', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('resolves false when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('resolves false when there is no clipboard', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('failure copy has no em-dash', () => {
    expect(COPY_FAILED).toBe("Couldn't copy");
  });
});

// Every copy site goes through copyText and shows the failure copy on false
// (PaintLog keeps its own "Select below" fallback state).
describe('copy call sites', () => {
  const sites = [
    'src/components/comments/Comments.tsx',
    'src/components/pages/PostDetailPage.tsx',
    'src/components/chat/MessageThread.tsx',
    'src/components/pages/assets/AssetActionSheet.tsx',
    'src/components/pages/assets/AssetLightbox.tsx',
    'src/components/support/ContactSheet.tsx',
    'src/components/pages/BriefDetailPage.tsx',
    'src/components/pages/pcs/PostActionSheet.tsx',
    'src/components/chat/PaintLog.tsx',
  ];

  it.each(sites)('%s copies via copyText, never navigator.clipboard', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toContain('copyText(');
    expect(src).not.toContain('navigator.clipboard');
    expect(src).not.toContain('writeClipboard');
  });

  it.each(sites.filter((p) => !p.endsWith('PaintLog.tsx')))('%s shows the failure copy', (path) => {
    expect(readFileSync(path, 'utf8')).toContain('COPY_FAILED');
  });

  it('PaintLog falls back to its failed state on false', () => {
    const src = readFileSync('src/components/chat/PaintLog.tsx', 'utf8');
    expect(src).toContain("setCopy(ok ? 'copied' : 'failed')");
  });
});
