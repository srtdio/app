import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  FileTile,
  FileTileBody,
  fileTileMeta,
  storedThumbnailMeta,
  type FileTileBodyProps,
} from '@/components/ui/FileTile';
import type { PresignCache } from '@/lib/asset-presign';
import { rememberThumbnail } from '@/lib/chat/attachments';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function body(overrides: Partial<FileTileBodyProps> = {}, theme: 'light' | 'dark' = 'light') {
  return renderToStaticMarkup(
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <FileTileBody
        kind="pdf"
        thumbUrl={null}
        name="Q3 launch brief.pdf"
        meta={fileTileMeta(PDF, undefined, 240_000)}
        {...overrides}
      />
    </div>,
  );
}

describe('FileTileBody', () => {
  it('a tile with a thumbnail shows the stored image, cropped from the top for a PDF', () => {
    const html = body({ thumbUrl: 'https://signed/thumb' });
    expect(html).toContain('data-file-tile-thumb');
    expect(html).toContain('src="https://signed/thumb"');
    expect(html).toContain('object-top');
    expect(html).not.toContain('data-file-tile-icon');
  });

  it('a video thumbnail carries the play badge', () => {
    const html = body({
      kind: 'video',
      thumbUrl: 'https://signed/t',
      meta: fileTileMeta('video/mp4', undefined, 1),
    });
    expect(html).toContain('data-file-tile="video"');
    expect(html).toContain('bg-overlay');
  });

  it('no thumbnail: the icon card, as the chat file bubble shows it', () => {
    const html = body();
    expect(html).toContain('data-file-tile-icon');
    expect(html).not.toContain('<img');
  });

  it('is drawn from theme tokens only: the same markup in light and dark, no hex, no dark: literals', () => {
    const light = body({ thumbUrl: 'https://signed/t' }, 'light');
    const dark = body({ thumbUrl: 'https://signed/t' }, 'dark');
    expect(light.replace(' class="dark"', '')).toBe(dark.replace(' class="dark"', ''));
    expect(light).not.toMatch(/#[0-9a-f]{3,6}\b|dark:|scale-/i);
  });

  it('a long name wraps to two lines, cut in the middle, keeping the extension', () => {
    const name = 'Brand guidelines - client review round two - final final v12.pdf';
    const html = body({ name });
    expect(html).toContain('line-clamp-2');
    expect(html).toMatch(/data-file-name="" title="Brand guidelines[^"]*v12\.pdf"/);
    const shown = /data-file-name[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(shown).toContain('…');
    expect(shown.endsWith('.pdf')).toBe(true);
    expect(shown.length).toBeLessThan(name.length);
  });

  it('the card layout reserves a 4/3 thumbnail and two name lines, so its height is fixed', () => {
    const html = body({ layout: 'card' });
    expect(html).toContain('aspect-[4/3]');
    expect(html).toContain('h-8');
  });
});

describe('fileTileMeta', () => {
  it('a PDF with a known page count: kind, pages, size', () => {
    expect(fileTileMeta(PDF, 12, 240_000).map((p) => p.text)).toEqual([
      'PDF',
      '12 pages',
      expect.stringMatching(/KB/),
    ]);
    expect(fileTileMeta(PDF, 1, null).map((p) => p.text)).toEqual(['PDF', '1 page']);
  });

  it('a PDF without a page count: kind and size only', () => {
    expect(fileTileMeta(PDF, undefined, 240_000).map((p) => p.text)).toEqual([
      'PDF',
      expect.stringMatching(/KB/),
    ]);
    expect(fileTileMeta(PDF, undefined, null).map((p) => p.text)).toEqual(['PDF']);
  });

  it('the kind label comes from the server mime, never the name', () => {
    expect(fileTileMeta(DOCX, undefined, null)[0]?.text).toBe('Word');
    expect(fileTileMeta('', undefined, null)[0]?.text).toBe('File');
  });
});

describe('storedThumbnailMeta', () => {
  it('reads the page count and thumbnail size recorded for a version this session', () => {
    expect(storedThumbnailMeta('ver-tile-1', PDF)).toBeNull();
    rememberThumbnail('ver-tile-1', { width: 580, height: 751, pageCount: 9 });
    expect(storedThumbnailMeta('ver-tile-1', PDF)).toEqual({
      thumbW: 580,
      thumbH: 751,
      pageCount: 9,
    });
    expect(storedThumbnailMeta('', PDF)).toBeNull();
  });
});

describe('FileTile', () => {
  function stubCache() {
    const thumbnail = vi.fn(() => new Promise<never>(() => {}));
    const peekThumbnail = vi.fn(() => ({
      url: 'https://signed/t',
      expiresAt: Date.now() + 60_000,
    }));
    return {
      cache: { thumbnail, peekThumbnail } as unknown as PresignCache,
      thumbnail,
      peekThumbnail,
    };
  }

  it('asks for nothing before the tile is near the viewport (first paint: the icon card)', () => {
    const { cache, thumbnail, peekThumbnail } = stubCache();
    const html = renderToStaticMarkup(
      <FileTile kind="pdf" mime={PDF} name="a.pdf" versionId="v1" cache={cache} presignEnabled />,
    );
    expect(html).toContain('data-file-tile-icon');
    expect(thumbnail).not.toHaveBeenCalled();
    expect(peekThumbnail).not.toHaveBeenCalled();
  });

  it('Office and other files never ask for a thumbnail', () => {
    const { cache, thumbnail } = stubCache();
    const html = renderToStaticMarkup(
      <FileTile
        kind="office"
        mime={DOCX}
        name="a.docx"
        versionId="v1"
        cache={cache}
        presignEnabled
      />,
    );
    expect(html).toContain('data-file-tile="office"');
    expect(html).toContain('Word');
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it('shows the page count recorded for its version', () => {
    const { cache } = stubCache();
    rememberThumbnail('ver-tile-2', { width: 100, height: 130, pageCount: 3 });
    const html = renderToStaticMarkup(
      <FileTile
        kind="pdf"
        mime={PDF}
        name="a.pdf"
        versionId="ver-tile-2"
        size={2048}
        cache={cache}
        presignEnabled
      />,
    );
    expect(html).toContain('3 pages');
    expect(html).toContain('2 KB');
  });
});
