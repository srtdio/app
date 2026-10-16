import { describe, expect, it } from 'vitest';
import {
  REASONS,
  checkLink,
  foldLookalike,
  isShortener,
  registrableDomain,
} from '@/lib/links/safety';

function reasons(url: string): string[] {
  return checkLink(url).reasons;
}

describe('checkLink', () => {
  it('passes a normal https link', () => {
    expect(checkLink('https://example.com/a/b?c=1')).toEqual({ verdict: 'ok', reasons: [] });
    expect(checkLink('https://www.economictimes.com/industry/festive').verdict).toBe('ok');
  });

  it('rejects non-web schemes and unparseable input', () => {
    expect(reasons('javascript:alert(1)')).toEqual([REASONS.scheme]);
    expect(reasons('ftp://example.com/x')).toEqual([REASONS.scheme]);
    expect(reasons('not a url')).toEqual([REASONS.invalid]);
  });

  it('flags plain http with the prototype wording', () => {
    expect(checkLink('http://example.com').verdict).toBe('unsafe');
    expect(reasons('http://example.com')).toEqual(['Not a secure (https) link']);
  });

  it('flags an unusual port, allows 80 / 443 / none', () => {
    expect(reasons('https://example.com:8080/x')).toEqual(['Uses an unusual port']);
    expect(checkLink('https://example.com:443/x').verdict).toBe('ok');
    expect(reasons('https://example.com:80/x')).toEqual([]);
  });

  it('flags raw IPv4 and IPv6 hosts', () => {
    expect(reasons('https://192.168.1.1/')).toContain(REASONS.ip);
    expect(reasons('https://[::1]/')).toContain(REASONS.ip);
    expect(reasons('https://8.8.8.8/')).toContain(REASONS.ip);
    // A decimal-encoded IP is normalised by URL parsing, then caught.
    expect(reasons('https://3232235777/')).toContain(REASONS.ip);
  });

  it('flags local and internal names', () => {
    for (const url of [
      'https://localhost/',
      'https://printer.local/',
      'https://db.internal/',
      'https://app.localhost/',
      'https://intranet/',
    ]) {
      expect(reasons(url)).toContain(REASONS.local);
    }
    expect(reasons('https://local-news.com/')).toEqual([]);
  });

  it('flags punycode / mixed-script hosts', () => {
    expect(reasons('https://xn--pple-43d.com/')).toContain(REASONS.punycode);
    // Cyrillic a in apple: URL parsing emits xn--, which is caught.
    expect(reasons('https://аpple.com/')).toContain(REASONS.punycode);
    expect(checkLink('https://apple.com/').verdict).toBe('ok');
  });

  it('flags brand lookalikes via digit/letter swaps', () => {
    expect(reasons('https://g00gle-docs-share.top/')).toContain(REASONS.lookalike);
    expect(reasons('https://paypa1.com/')).toContain(REASONS.lookalike);
    expect(reasons('https://rnicrosoft.com/')).toContain(REASONS.lookalike);
    expect(reasons('https://faceb00k-login.in/')).toContain(REASONS.lookalike);
    expect(reasons('https://vvhatsapp.com/')).toContain(REASONS.lookalike);
    expect(reasons('https://in5tagram.com/')).toContain(REASONS.lookalike);
    expect(reasons('https://app1e.com/')).toContain(REASONS.lookalike);
  });

  it('flags a brand inside a non-brand registrable domain', () => {
    expect(reasons('https://google-docs-share.top/')).toContain(REASONS.brand);
    expect(reasons('https://sbi-kyc-update.in/')).toContain(REASONS.brand);
    expect(reasons('https://paypal.com.secure-login.top/')).toContain(REASONS.brand);
    expect(reasons('https://mygoogledrive.xyz/')).toContain(REASONS.brand);
    expect(reasons('https://microsoft.github.io/')).toContain(REASONS.brand);
  });

  it('passes the brands themselves and their official domains', () => {
    for (const url of [
      'https://docs.google.com/document/d/1',
      'https://drive.google.com/file/d/1aX9/view',
      'https://sbi.co.in/',
      'https://www.onlinesbi.sbi/',
      'https://www.hdfcbank.com/',
      'https://www.icicibank.com/',
      'https://www.youtube.com/watch?v=1',
      'https://youtu.be/abc',
      'https://www.instagram.com/p/C9x2/',
      'https://www.canva.com/design/DAF1/view',
      'https://www.amazon.in/dp/1',
      'https://www.linkedin.com/in/x',
      'https://wa.me/919999999999',
    ]) {
      expect(checkLink(url)).toEqual({ verdict: 'ok', reasons: [] });
    }
  });

  it('leaves everyday words that are also brand names alone', () => {
    expect(checkLink('https://best-office-chairs.in/').verdict).toBe('ok');
    expect(checkLink('https://apple-pie.blog/').verdict).toBe('ok');
    expect(checkLink('https://www.metacritic.com/').verdict).toBe('ok');
    expect(checkLink('https://www.applebees.com/').verdict).toBe('ok');
  });

  it('flags risky downloads, not ordinary files', () => {
    expect(reasons('https://example.com/app.apk')).toEqual([REASONS.download]);
    expect(reasons('https://example.com/Setup.EXE')).toEqual([REASONS.download]);
    expect(reasons('https://example.com/run%2Eps1')).toEqual([REASONS.download]);
    expect(reasons('https://example.com/a/b.js')).toEqual([REASONS.download]);
    expect(checkLink('https://example.com/deck.pdf').verdict).toBe('ok');
    expect(checkLink('https://example.com/js/').verdict).toBe('ok');
  });

  it('flags credentials in the URL', () => {
    expect(reasons('https://user:pass@example.com/')).toEqual([REASONS.credentials]);
    expect(reasons('https://user@example.com/')).toEqual([REASONS.credentials]);
  });

  it('lists every reason that fires, in a stable order', () => {
    expect(reasons('http://g00gle-docs-share.top:8080/login?next=x')).toEqual([
      'Uses an unusual port',
      'Not a secure (https) link',
      'Looks like a famous site but is spelled differently',
    ]);
  });
});

describe('helpers', () => {
  it('registrableDomain uses the built-in suffix subset', () => {
    expect(registrableDomain('docs.google.com')).toBe('google.com');
    expect(registrableDomain('www.sbi.co.in')).toBe('sbi.co.in');
    expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('x.nic.gov.in')).toBe('nic.gov.in');
    expect(registrableDomain('example.com')).toBe('example.com');
  });

  it('isShortener recognises the shortener list', () => {
    expect(isShortener('bit.ly')).toBe(true);
    expect(isShortener('www.tinyurl.com')).toBe(true);
    expect(isShortener('canva.com')).toBe(false);
  });

  it('foldLookalike folds the swap pairs', () => {
    expect(foldLookalike('G00gle')).toBe(foldLookalike('google'));
    expect(foldLookalike('rnicro5oft')).toBe(foldLookalike('microsoft'));
    expect(foldLookalike('vvhatsapp')).toBe(foldLookalike('whatsapp'));
  });
});

describe('real-world domains (audit round 2)', () => {
  it.each([
    'https://sbi.bank.in/',
    'https://www.hdfc.bank.in/',
    'https://icici.bank.in/',
    'https://kotak.bank.in/',
    'https://m.media-amazon.com/images/I/a.jpg',
    'https://shoppingmall.com/',
    'https://bigmall.in/',
    'https://intelcloud.com/',
    'https://apicloud.com/',
    'https://paytmmall.com/',
    'https://github.com/x/y/blob/main/index.js',
    'https://www.google.com.hk/',
    'https://www.google.co.kr/',
    'https://mybrand.canva.site/',
    'https://www.icloud.com/',
    'https://maps.app.goo.gl/abc',
  ])('%s is ok', (url) => {
    expect(checkLink(url)).toEqual({ verdict: 'ok', reasons: [] });
  });

  it.each([
    'https://paypal.top/',
    'https://icici.xyz/',
    'https://sbi.help/',
    'https://g00gledocs.com/',
  ])('%s is unsafe', (url) => {
    expect(checkLink(url).verdict).toBe('unsafe');
  });

  it('raw code downloads stay flagged', () => {
    expect(checkLink('https://raw.githubusercontent.com/x/y/main/run.ps1').verdict).toBe('unsafe');
  });
});
