import { describe, expect, it } from 'vitest';
import {
  APP_ENTITY_ROUTES,
  classify,
  displayUrl,
  firstExternalUrl,
  tokenize,
} from '@/lib/chat/message-links';

const ORIGIN = 'https://app.example.test';

describe('tokenize', () => {
  it('keeps plain text as one run', () => {
    expect(tokenize('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('splits one url out of the text', () => {
    expect(tokenize('see https://example.com/a here')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'url', url: 'https://example.com/a' },
      { kind: 'text', text: ' here' },
    ]);
  });

  it('trims trailing punctuation off a url into the text', () => {
    expect(tokenize('(look: http://example.com/x).')).toEqual([
      { kind: 'text', text: '(look: ' },
      { kind: 'url', url: 'http://example.com/x' },
      { kind: 'text', text: ').' },
    ]);
  });

  it('splits two urls', () => {
    expect(tokenize('https://a.test https://b.test/p')).toEqual([
      { kind: 'url', url: 'https://a.test' },
      { kind: 'text', text: ' ' },
      { kind: 'url', url: 'https://b.test/p' },
    ]);
  });

  it('does not match a url without an http(s) scheme', () => {
    expect(tokenize('go to example.com or ftp://x.test')).toEqual([
      { kind: 'text', text: 'go to example.com or ftp://x.test' },
    ]);
  });
});

describe('classify', () => {
  it('an outside url is external', () => {
    expect(classify('https://example.com/p/gbl-1', ORIGIN, APP_ENTITY_ROUTES)).toEqual({
      kind: 'external',
    });
  });

  it('a same-origin post link is internal with its ref', () => {
    expect(classify(`${ORIGIN}/p/gbl-142`, ORIGIN, APP_ENTITY_ROUTES)).toEqual({
      kind: 'post',
      ref: { key: 'GBL', number: 142 },
      path: '/p/gbl-142',
    });
  });

  it('a same-origin brief link is internal with its ref', () => {
    expect(classify(`${ORIGIN}/b/Gbl-0007?x=1`, ORIGIN, APP_ENTITY_ROUTES)).toEqual({
      kind: 'brief',
      ref: { key: 'GBL', number: 7 },
      path: '/b/Gbl-0007?x=1',
    });
  });

  it('a foreign origin with the same path is external', () => {
    expect(classify('https://other.test/p/gbl-142', ORIGIN, APP_ENTITY_ROUTES)).toEqual({
      kind: 'external',
    });
  });

  it('other same-origin paths, bad refs and no origin are external', () => {
    expect(classify(`${ORIGIN}/pipeline`, ORIGIN, APP_ENTITY_ROUTES).kind).toBe('external');
    expect(classify(`${ORIGIN}/p/not-a-ref`, ORIGIN, APP_ENTITY_ROUTES).kind).toBe('external');
    expect(classify(`${ORIGIN}/p/gbl-1`, null, APP_ENTITY_ROUTES).kind).toBe('external');
  });
});

describe('displayUrl', () => {
  it('drops the scheme', () => {
    expect(displayUrl('https://example.com/a')).toBe('example.com/a');
    expect(displayUrl('http://example.com')).toBe('example.com');
  });
});

describe('firstExternalUrl', () => {
  it('returns only the first external link', () => {
    expect(
      firstExternalUrl('see https://a.com/x and https://b.com/y.', ORIGIN, APP_ENTITY_ROUTES),
    ).toBe('https://a.com/x');
  });

  it('skips internal post/brief links and other same-origin pages', () => {
    expect(
      firstExternalUrl(
        `${ORIGIN}/p/abc ${ORIGIN}/settings then https://c.com/`,
        ORIGIN,
        APP_ENTITY_ROUTES,
      ),
    ).toBe('https://c.com/');
  });

  it('is null when there is no external link', () => {
    expect(firstExternalUrl('no links here', ORIGIN, APP_ENTITY_ROUTES)).toBeNull();
  });
});

describe('tokenize: a closing format marker after a url', () => {
  it('*see https://x.com* keeps the closing star out of the url', () => {
    expect(tokenize('*see https://x.com*')).toEqual([
      { kind: 'text', text: '*see ' },
      { kind: 'url', url: 'https://x.com' },
      { kind: 'text', text: '*' },
    ]);
  });

  it('a trailing marker with no opener stays in the url', () => {
    expect(tokenize('see https://x.com/a_')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'url', url: 'https://x.com/a_' },
    ]);
  });

  it('firstExternalUrl drops the closing marker', () => {
    expect(firstExternalUrl('_read https://x.com/post_', ORIGIN, APP_ENTITY_ROUTES)).toBe(
      'https://x.com/post',
    );
  });
});

describe('tokenize: [text](url) links', () => {
  it('a link is one run with its text and url, found before bare urls', () => {
    expect(tokenize('see [the deck](https://a.test/d) and https://b.test')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the deck', url: 'https://a.test/d' },
      { kind: 'text', text: ' and ' },
      { kind: 'url', url: 'https://b.test' },
    ]);
  });

  it('the url inside a link is never a bare url run, and its ")" is not text', () => {
    expect(tokenize('[x](https://a.test/p).')).toEqual([
      { kind: 'link', text: 'x', url: 'https://a.test/p' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('a bare url right before a link keeps its own run', () => {
    expect(tokenize('https://a.test [b](https://b.test)')).toEqual([
      { kind: 'url', url: 'https://a.test' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'b', url: 'https://b.test' },
    ]);
  });

  it('a closing marker after a url before a link still leaves the url', () => {
    expect(tokenize('[a](https://a.test) *see https://x.com*')).toEqual([
      { kind: 'link', text: 'a', url: 'https://a.test' },
      { kind: 'text', text: ' *see ' },
      { kind: 'url', url: 'https://x.com' },
      { kind: 'text', text: '*' },
    ]);
  });

  it('a non-http link or a broken one stays text', () => {
    expect(tokenize('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ]);
    expect(tokenize('[x] (https://a.test)')).toEqual([
      { kind: 'text', text: '[x] (' },
      { kind: 'url', url: 'https://a.test' },
      { kind: 'text', text: ')' },
    ]);
  });

  it("firstExternalUrl counts a link's url like a pasted url; own-app links are skipped", () => {
    expect(firstExternalUrl('read [this](https://c.test/a)', ORIGIN, APP_ENTITY_ROUTES)).toBe(
      'https://c.test/a',
    );
    const body = `[post](${ORIGIN}/p/gbl-142) then [ext](https://d.test)`;
    expect(firstExternalUrl(body, ORIGIN, APP_ENTITY_ROUTES)).toBe('https://d.test');
  });

  it('long input with many brackets is linear (no backtracking)', () => {
    const body = `${'[a'.repeat(20000)} ${'](h'.repeat(20000)} [ok](https://e.test)`;
    const t0 = Date.now();
    const out = tokenize(body);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out[out.length - 1]).toEqual({ kind: 'link', text: 'ok', url: 'https://e.test' });
  });
});
