import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  ICON_LINKS,
  OG_IMAGE,
  PRERENDER_ATTR,
  SEO_ROUTES,
  SITE_URL,
  canonicalUrl,
  homeJsonLd,
  prerenderDocument,
  routeHeadTags,
  sitemapRoutes,
  sitemapXml,
} from './seo-routes';

const repo = process.cwd();
const read = (path: string): string => readFileSync(join(repo, path), 'utf8');
const EMPTY_ROOT = '<div id="root"></div>';

/** Visible text of an HTML fragment: tags, scripts and styles stripped. */
function bodyText(html: string): string {
  const body = html.slice(html.indexOf('<body'));
  return body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('seo routes', () => {
  it('every route has a title, a description and a canonical URL on srtd.io', () => {
    expect(SEO_ROUTES.map((r) => r.path)).toEqual([
      '/',
      '/legal/privacy-policy',
      '/legal/terms-and-conditions',
      '/demo',
    ]);
    for (const route of SEO_ROUTES) {
      expect(route.title.length).toBeGreaterThan(0);
      expect(route.description.length).toBeGreaterThan(0);
      expect(route.title).not.toMatch(/—/);
      expect(route.description).not.toMatch(/—/);
      const head = routeHeadTags(route);
      expect(head).toContain(`<link rel="canonical" href="${canonicalUrl(route.path)}" />`);
      expect(canonicalUrl(route.path).startsWith(`${SITE_URL}/`)).toBe(true);
      for (const property of [
        'og:type',
        'og:site_name',
        'og:title',
        'og:description',
        'og:url',
        'og:image',
        'og:image:width',
        'og:image:height',
        'og:image:alt',
      ]) {
        expect(head).toContain(`<meta property="${property}" `);
      }
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(head).toContain(`content="${SITE_URL}${OG_IMAGE.path}"`);
    }
  });

  it('marks /demo noindex and nothing else', () => {
    const noindex = SEO_ROUTES.filter((r) =>
      routeHeadTags(r).includes('<meta name="robots" content="noindex" />'),
    );
    expect(noindex.map((r) => r.path)).toEqual(['/demo']);
  });

  it('lists exactly the three indexable routes in the sitemap', () => {
    expect(sitemapRoutes().map((r) => r.path)).toEqual([
      '/',
      '/legal/privacy-policy',
      '/legal/terms-and-conditions',
    ]);
    const xml = sitemapXml('2026-10-16');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      'https://srtd.io/',
      'https://srtd.io/legal/privacy-policy',
      'https://srtd.io/legal/terms-and-conditions',
    ]);
    expect(xml.match(/<lastmod>2026-10-16<\/lastmod>/g)).toHaveLength(3);
  });

  it('titles "/" with the approved line; /demo and legal keep their titles', () => {
    const T = 'Sorted (free) | Approvals and chat for social media teams';
    expect(HOME_TITLE).toBe(T);
    const home = SEO_ROUTES.find((r) => r.path === '/');
    expect(home?.title).toBe(T);
    if (home === undefined) throw new Error('no "/" route');
    const head = routeHeadTags(home);
    expect(head).toContain(`<meta property="og:title" content="${T}" />`);
    expect(head).toContain(`<meta name="twitter:title" content="${T}" />`);
    expect(SEO_ROUTES.filter((r) => r.path !== '/').map((r) => [r.path, r.title])).toEqual([
      ['/legal/privacy-policy', 'Privacy policy | Sorted'],
      ['/legal/terms-and-conditions', 'Terms and conditions | Sorted'],
      ['/demo', 'Demo | Sorted'],
    ]);
    for (const route of SEO_ROUTES) {
      expect(routeHeadTags(route)).toContain(
        `<meta name="twitter:title" content="${route.title}" />`,
      );
    }
  });

  it('describes "/" and /demo with the approved line, in every description tag', () => {
    const D =
      'Free. One place for social media teams to chat, plan posts, share files and get approvals on record.';
    expect(HOME_DESCRIPTION).toBe(D);
    for (const path of ['/', '/demo']) {
      const route = SEO_ROUTES.find((r) => r.path === path);
      expect(route?.description).toBe(D);
      if (route === undefined) continue;
      const head = routeHeadTags(route);
      expect(head).toContain(`<meta name="description" content="${D}" />`);
      expect(head).toContain(`<meta property="og:description" content="${D}" />`);
      expect(head).toContain(`<meta name="twitter:description" content="${D}" />`);
    }
    for (const route of SEO_ROUTES.filter((r) => r.path.startsWith('/legal/'))) {
      expect(route.description).not.toBe(D);
    }
  });

  it('puts JSON-LD on "/" only: a free INR offer, no ratings or reviews', () => {
    for (const route of SEO_ROUTES) {
      expect(routeHeadTags(route).includes('application/ld+json')).toBe(route.path === '/');
    }
    expect(homeJsonLd().map((item) => item['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
    ]);
    const app = homeJsonLd()[2];
    expect(app?.description).toBe(HOME_DESCRIPTION);
    expect(app?.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'INR' });
    expect(homeJsonLd()[0]).not.toHaveProperty('offers');
    expect(homeJsonLd()[1]).not.toHaveProperty('offers');
    const keys: string[] = [];
    JSON.stringify(homeJsonLd(), (key: string, value: unknown) => {
      keys.push(key);
      return value;
    });
    for (const banned of ['aggregateRating', 'review', 'reviews', 'reviewRating', 'ratingValue']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('fills the shell without dropping anything from its head', () => {
    const template = `<html><head><meta name="theme-color" content="#f7f8f9" /><title>Sorted</title></head><body>${EMPTY_ROOT}</body></html>`;
    const route = SEO_ROUTES[0];
    if (route === undefined) throw new Error('no routes');
    const html = prerenderDocument({
      template,
      route,
      markup: '<main>Hi</main>',
      stylesheets: ['/assets/a.css'],
    });
    expect(html).toContain('<meta name="theme-color" content="#f7f8f9" />');
    expect(html).toContain(`<title>${route.title}</title>`);
    expect(html).toContain(`<div id="root" ${PRERENDER_ATTR}="home"><main>Hi</main></div>`);
    expect(html).toContain('href="/assets/a.css" data-prerender-css');
    expect(() =>
      prerenderDocument({ template: '<html></html>', route, markup: '', stylesheets: [] }),
    ).toThrow();
  });
});

describe('static files and shell', () => {
  it('links the icons and manifest from the shell head', () => {
    const head = read('index.html').split('</head>')[0] ?? '';
    for (const link of ICON_LINKS) expect(head).toContain(`href="${link.href}"`);
    expect(read('index.html')).toContain(EMPTY_ROOT);
  });

  it('uses only the canonical origin in robots.txt, llms.txt and _headers', () => {
    for (const file of ['public/robots.txt', 'public/llms.txt', 'public/_headers']) {
      for (const [origin] of read(file).matchAll(/https?:\/\/[^/\s)]+/g)) {
        expect(origin).toBe(SITE_URL);
      }
    }
    expect(read('public/robots.txt')).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  it('keeps /og/ crawlable and adds no Content-Security-Policy', () => {
    expect(read('public/robots.txt')).not.toMatch(/Disallow: \/og/);
    expect(read('public/_headers')).not.toMatch(/Content-Security-Policy/i);
  });

  it('has no /pricing page: no route, no header exception (it 301s to /)', () => {
    expect(SEO_ROUTES.some((r) => r.path === '/pricing')).toBe(false);
    expect(read('public/_headers')).not.toMatch(/pricing/);
    expect(read('index.html')).not.toMatch(/pricing/);
  });

  it('llms.txt carries the approved line as its summary and Home description, nothing more', () => {
    expect(read('public/llms.txt')).toBe(
      [
        '# Sorted',
        '',
        `> ${HOME_DESCRIPTION}`,
        '',
        '## Pages',
        '',
        `- [Home](${SITE_URL}/): ${HOME_DESCRIPTION}`,
        `- [Privacy policy](${SITE_URL}/legal/privacy-policy): Sorted's privacy policy.`,
        `- [Terms and conditions](${SITE_URL}/legal/terms-and-conditions): Sorted's terms and conditions.`,
        '',
      ].join('\n'),
    );
  });
});

// Runs after `pnpm build` (dist/ present); skipped in a plain `pnpm test`.
describe.runIf(existsSync(join(repo, 'dist', 'prerender', 'home.html')))('build output', () => {
  it('prerenders every route with real body text and its own head', () => {
    for (const route of SEO_ROUTES) {
      const html = read(join('dist', route.file));
      expect(html).toContain(`<title>${route.title.replace(/&/g, '&amp;')}</title>`);
      expect(html).toContain(`${PRERENDER_ATTR}="${route.bundle}"`);
      expect(bodyText(html).length).toBeGreaterThan(400);
      expect(html).not.toMatch(/fbevents|googletagmanager|licdn/);
    }
  });

  it('writes no /pricing page', () => {
    expect(existsSync(join(repo, 'dist', 'pricing.html'))).toBe(false);
  });

  it('leaves the app fallback shell with an empty #root', () => {
    const shell = read('dist/index.html');
    expect(shell).toContain(EMPTY_ROOT);
    expect(shell).toContain('<title>Sorted</title>');
    expect(bodyText(shell)).toBe('');
  });

  it('writes the sitemap and copies the static files', () => {
    expect(read('dist/sitemap.xml')).toContain(`<loc>${SITE_URL}/</loc>`);
    for (const file of ['robots.txt', 'llms.txt', 'og-image.png', 'favicon.ico', '_headers']) {
      expect(existsSync(join(repo, 'dist', file))).toBe(true);
    }
    expect(existsSync(join(repo, 'dist', '.vite'))).toBe(false);
  });
});
