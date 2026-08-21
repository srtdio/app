import { describe, expect, it } from 'vitest';
import { parseExternalLink, toExternalLinks } from '@/lib/links';

describe('parseExternalLink', () => {
  it('accepts https and returns the parsed href with the bare domain', () => {
    expect(parseExternalLink('https://drive.google.com/file/d/abc?x=1')).toEqual({
      href: 'https://drive.google.com/file/d/abc?x=1',
      domain: 'drive.google.com',
    });
  });

  it('accepts http as well as https', () => {
    expect(parseExternalLink('http://example.com/a')).toEqual({
      href: 'http://example.com/a',
      domain: 'example.com',
    });
  });

  it('strips a leading www. and lowercases the host, leaving the path untouched', () => {
    expect(parseExternalLink('https://WWW.Figma.com/file/ABC')).toEqual({
      href: 'https://www.figma.com/file/ABC',
      domain: 'figma.com',
    });
  });

  it('keeps a host that merely starts with www elsewhere (only a leading www. goes)', () => {
    expect(parseExternalLink('https://wwwtest.example.com')?.domain).toBe('wwwtest.example.com');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseExternalLink('  https://srtd.io/x  ')?.href).toBe('https://srtd.io/x');
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(parseExternalLink('')).toBeNull();
    expect(parseExternalLink('   ')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(parseExternalLink(null)).toBeNull();
    expect(parseExternalLink(undefined)).toBeNull();
    expect(parseExternalLink(42)).toBeNull();
    expect(parseExternalLink({ url: 'https://srtd.io' })).toBeNull();
    expect(parseExternalLink(['https://srtd.io'])).toBeNull();
  });

  it('rejects malformed input that never parses as an absolute URL', () => {
    expect(parseExternalLink('not-a-url')).toBeNull();
    expect(parseExternalLink('www.foo.com')).toBeNull();
    expect(parseExternalLink('/relative/path')).toBeNull();
    expect(parseExternalLink('https://')).toBeNull();
  });

  it('rejects every non-http(s) scheme, including javascript: and data:', () => {
    expect(parseExternalLink('javascript:alert(1)')).toBeNull();
    expect(parseExternalLink('JavaScript:alert(1)')).toBeNull();
    expect(parseExternalLink('data:text/html,<script>x</script>')).toBeNull();
    expect(parseExternalLink('file:///etc/passwd')).toBeNull();
    expect(parseExternalLink('mailto:a@b.com')).toBeNull();
    expect(parseExternalLink('ftp://example.com/x')).toBeNull();
  });
});

describe('toExternalLinks (legacy reference_links shapes)', () => {
  it('normalises a bare string', () => {
    expect(toExternalLinks('https://notion.so/brief')).toEqual([
      { href: 'https://notion.so/brief', domain: 'notion.so' },
    ]);
  });

  it('normalises a string[] and preserves order', () => {
    expect(toExternalLinks(['https://a.example/1', 'https://b.example/2'])).toEqual([
      { href: 'https://a.example/1', domain: 'a.example' },
      { href: 'https://b.example/2', domain: 'b.example' },
    ]);
  });

  it('normalises an array of { url } objects', () => {
    expect(toExternalLinks([{ url: 'https://www.figma.com/file/abc' }])).toEqual([
      { href: 'https://www.figma.com/file/abc', domain: 'figma.com' },
    ]);
  });

  it('normalises the v1 ETL { drive_link, images } object, ignoring its other keys', () => {
    expect(
      toExternalLinks({
        drive_link: 'https://drive.google.com/folder/xyz',
        images: ['key/one.png'],
      }),
    ).toEqual([{ href: 'https://drive.google.com/folder/xyz', domain: 'drive.google.com' }]);
  });

  it('keeps the valid entries out of a mixed array and drops the rest', () => {
    expect(
      toExternalLinks([
        'not-a-url',
        'https://good.example/a',
        { url: 'javascript:alert(1)' },
        { url: 'https://ok.example/b' },
        null,
        42,
        '',
      ]),
    ).toEqual([
      { href: 'https://good.example/a', domain: 'good.example' },
      { href: 'https://ok.example/b', domain: 'ok.example' },
    ]);
  });

  it('dedupes by href, first occurrence wins, order preserved', () => {
    expect(
      toExternalLinks([
        'https://one.example/a',
        'https://two.example/b',
        { url: 'https://one.example/a' },
        '  https://one.example/a  ',
      ]),
    ).toEqual([
      { href: 'https://one.example/a', domain: 'one.example' },
      { href: 'https://two.example/b', domain: 'two.example' },
    ]);
  });

  it('treats two paths on the same domain as distinct links', () => {
    expect(
      toExternalLinks(['https://drive.google.com/a', 'https://drive.google.com/b']),
    ).toHaveLength(2);
  });

  it('returns [] for unknown shapes and for nothing usable', () => {
    expect(toExternalLinks(null)).toEqual([]);
    expect(toExternalLinks(undefined)).toEqual([]);
    expect(toExternalLinks(42)).toEqual([]);
    expect(toExternalLinks(true)).toEqual([]);
    expect(toExternalLinks({})).toEqual([]);
    expect(toExternalLinks({ images: ['a.png'] })).toEqual([]);
    expect(toExternalLinks([])).toEqual([]);
    expect(toExternalLinks(['nope', { url: 'nope' }])).toEqual([]);
  });
});
