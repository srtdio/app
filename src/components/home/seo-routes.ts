// Search and link-preview metadata for the prerendered public pages. The one
// source of truth for titles, descriptions, canonical URLs, the sitemap and
// JSON-LD: scripts/prerender.ts reads it at build time. Imports nothing, so it
// stays out of every runtime bundle unless something asks for it.

/** Canonical origin. www and http 301 here, so every canonical URL uses it. */
export const SITE_URL = 'https://srtd.io';
export const SITE_NAME = 'Sorted';

/** "/" and /demo description, og:description and twitter:description; also the llms.txt summary. */
export const HOME_DESCRIPTION =
  'Free. One place for social media teams to chat, plan posts, share files and get approvals on record.';
/** What "free" covers; the line under the llms.txt summary. */
export const FREE_LIMITS = 'Sorted is free: one workspace and 1 GB per account. More on request.';

/** The og:image file, 1200x630, committed in public/. */
export const OG_IMAGE = {
  path: '/og-image.png',
  width: 1200,
  height: 630,
  alt: 'One place to chat, plan posts, share files and get approvals on record.',
} as const;

/** Icons and manifest linked from every HTML page head (shell and prerendered). */
export const ICON_LINKS = [
  { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'manifest', href: '/site.webmanifest' },
] as const;

/** home: hydrated by the home bundle. app: the app bundle renders it (createRoot). */
export type SeoBundle = 'home' | 'app';

export interface SeoRoute {
  path: string;
  title: string;
  description: string;
  /** false adds <meta name="robots" content="noindex"> and leaves it out of the sitemap. */
  indexable: boolean;
  bundle: SeoBundle;
  /** Output file under dist/. "/" is not index.html: that stays the empty app shell. */
  file: string;
}

export const SEO_ROUTES: readonly SeoRoute[] = [
  {
    path: '/',
    title: 'Sorted | Chat, plan posts, share files and get approvals',
    description: HOME_DESCRIPTION,
    indexable: true,
    bundle: 'home',
    file: 'prerender/home.html',
  },
  {
    path: '/legal/privacy-policy',
    title: 'Privacy policy | Sorted',
    description: "Sorted's privacy policy.",
    indexable: true,
    bundle: 'app',
    file: 'legal/privacy-policy.html',
  },
  {
    path: '/legal/terms-and-conditions',
    title: 'Terms and conditions | Sorted',
    description: "Sorted's terms and conditions.",
    indexable: true,
    bundle: 'app',
    file: 'legal/terms-and-conditions.html',
  },
  {
    path: '/demo',
    title: 'Demo | Sorted',
    description: HOME_DESCRIPTION,
    indexable: false,
    bundle: 'home',
    file: 'demo.html',
  },
];

/** Marks the #root a prerendered page fills; the inline head script in index.html reads it. */
export const PRERENDER_ATTR = 'data-prerender';

export function canonicalUrl(path: string): string {
  return path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}

export function sitemapRoutes(): SeoRoute[] {
  return SEO_ROUTES.filter((route) => route.indexable);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function meta(attr: 'name' | 'property', key: string, content: string): string {
  return `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`;
}

/** JSON-LD for "/": Organization, WebSite and SoftwareApplication (free offer). No ratings or reviews. */
export function homeJsonLd(): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
    },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description: HOME_DESCRIPTION,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
    },
  ];
}

/** Head tags for one route, after <title>: description, robots, canonical, OG, Twitter. */
export function routeHeadTags(route: SeoRoute): string {
  const url = canonicalUrl(route.path);
  const tags = [
    meta('name', 'description', route.description),
    ...(route.indexable ? [] : [meta('name', 'robots', 'noindex')]),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:title', route.title),
    meta('property', 'og:description', route.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', `${SITE_URL}${OG_IMAGE.path}`),
    meta('property', 'og:image:width', String(OG_IMAGE.width)),
    meta('property', 'og:image:height', String(OG_IMAGE.height)),
    meta('property', 'og:image:alt', OG_IMAGE.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:description', route.description),
  ];
  if (route.path === '/') {
    // "<" is escaped so the JSON can never close the script element.
    const json = JSON.stringify(homeJsonLd()).replace(/</g, '\\u003c');
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join('\n');
}

export interface PrerenderInput {
  /** The built shell (dist/index.html). */
  template: string;
  route: SeoRoute;
  /** renderToString output for the route. */
  markup: string;
  /** Stylesheets the first paint needs (hashed /assets/ files). */
  stylesheets: readonly string[];
}

/**
 * The prerendered page: the shell with this route's title and head tags, its
 * first-paint stylesheets and its markup in #root. Throws if the shell has
 * changed shape, so a broken build never ships an unfilled page.
 */
export function prerenderDocument({
  template,
  route,
  markup,
  stylesheets,
}: PrerenderInput): string {
  const title = '<title>Sorted</title>';
  const root = '<div id="root"></div>';
  if (!template.includes(title) || !template.includes(root)) {
    throw new Error('prerender: shell is missing <title>Sorted</title> or an empty #root');
  }
  const links = stylesheets.map(
    (href) => `<link rel="stylesheet" crossorigin href="${escapeHtml(href)}" data-prerender-css />`,
  );
  const head = [`<title>${escapeHtml(route.title)}</title>`, routeHeadTags(route), ...links];
  return template
    .replace(title, head.join('\n'))
    .replace(root, `<div id="root" ${PRERENDER_ATTR}="${route.bundle}">${markup}</div>`);
}

/** sitemap.xml for the indexable routes; lastmod is the build date (YYYY-MM-DD). */
export function sitemapXml(lastmod: string): string {
  const urls = sitemapRoutes().map(
    (route) =>
      `  <url>\n    <loc>${canonicalUrl(route.path)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
