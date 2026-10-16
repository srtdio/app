// Build-time prerender for the public pages (run by `pnpm build` after
// `vite build`, with Node's built-in TypeScript type stripping). It SSR-builds
// one virtual entry with Vite, renders each route in src/components/home/
// seo-routes.ts with react-dom/server, and writes real HTML into dist/:
//
//   dist/index.html                 empty app shell, untouched: Pages serves it
//                                   for every path with no file (SPA fallback)
//   dist/prerender/home.html        "/" (public/_redirects rewrites / to it)
//   dist/demo.html                  /demo
//   dist/legal/<policy>.html        /legal/privacy-policy, /legal/terms-and-conditions
//   dist/sitemap.xml                the indexable routes, lastmod = build date
//
// It then checks the output and exits non-zero if any page is unfilled or the
// shell is not empty, so a broken prerender fails the build.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, type Plugin } from 'vite';
import viteConfig from '../vite.config.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// `--dist <dir>` prerenders another build output (the e2e first-paint specs
// build into their own folder); the default is dist/.
const distArg = process.argv.indexOf('--dist');
const dist = distArg > 0 ? resolve(process.argv[distArg + 1] ?? 'dist') : join(repoRoot, 'dist');
// Inside the repo so the SSR bundle resolves react and friends from node_modules.
const ssrOut = join(repoRoot, 'node_modules', '.cache', 'srtd-prerender');

const ENTRY_ID = 'virtual:srtd-prerender';
const RESOLVED_ENTRY_ID = `\0${ENTRY_ID}`;

// The SSR entry: the same components the browser renders, wrapped as they are
// at runtime (StrictMode for the home bundle; a router for the legal page).
const ENTRY_SOURCE = `
import { StrictMode, createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { Route, Routes } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { HomeEntry } from '@/components/home/HomeEntry';
import { LegalPolicyPage } from '@/components/auth/LegalPolicyPage';
export * from '@/components/home/seo-routes';

export function renderRoute(route) {
  if (route.bundle === 'home') {
    return renderToString(h(StrictMode, null, h(HomeEntry, { pathname: route.path })));
  }
  return renderToString(
    h(StaticRouter, { location: route.path },
      h(Routes, null, h(Route, { path: '/legal/:policy', element: h(LegalPolicyPage) }))),
  );
}
`;

type SeoModule = typeof import('../src/components/home/seo-routes.ts');
interface PrerenderModule extends SeoModule {
  renderRoute: (route: SeoModule['SEO_ROUTES'][number]) => string;
}

interface ManifestChunk {
  file: string;
  css?: string[];
  imports?: string[];
}
type Manifest = Record<string, ManifestChunk>;

function fail(message: string): never {
  process.stderr.write(`prerender: ${message}\n`);
  process.exit(1);
}

function virtualEntry(): Plugin {
  return {
    name: 'srtd-prerender-entry',
    resolveId: (id) => (id === ENTRY_ID ? RESOLVED_ENTRY_ID : null),
    load: (id) => (id === RESOLVED_ENTRY_ID ? ENTRY_SOURCE : null),
  };
}

/** Every stylesheet a manifest entry needs on first paint, through its static imports. */
function stylesheetsFor(manifest: Manifest, key: string, seen = new Set<string>()): string[] {
  if (seen.has(key)) return [];
  seen.add(key);
  const chunk = manifest[key];
  if (chunk === undefined) fail(`manifest has no entry for ${key}`);
  const own = (chunk.css ?? []).map((file) => `/${file}`);
  const nested = (chunk.imports ?? []).flatMap((child) => stylesheetsFor(manifest, child, seen));
  return [...new Set([...nested, ...own])];
}

/** Visible text of an HTML fragment: tags, scripts and styles stripped. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main(): Promise<void> {
  const shellPath = join(dist, 'index.html');
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(shellPath) || !existsSync(manifestPath)) {
    fail('run vite build first (dist/index.html and dist/.vite/manifest.json are needed)');
  }
  const template = readFileSync(shellPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  await build({
    configFile: false,
    logLevel: 'warn',
    mode: 'production',
    root: repoRoot,
    plugins: [react(), virtualEntry()],
    resolve: viteConfig.resolve ?? {},
    build: {
      ssr: true,
      outDir: ssrOut,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: ENTRY_ID, output: { entryFileNames: 'prerender.mjs' } },
    },
  });
  const mod = (await import(pathToFileURL(join(ssrOut, 'prerender.mjs')).href)) as PrerenderModule;

  const homeCss = stylesheetsFor(manifest, 'src/components/home/HomeEntry.tsx');
  const appCssChunk = manifest['src/index.css'];
  if (appCssChunk === undefined) fail('manifest has no entry for src/index.css');
  const appCss = [`/${appCssChunk.file}`];
  if (homeCss.length === 0 || appCss.length === 0) fail('no stylesheet found for a bundle');

  for (const route of mod.SEO_ROUTES) {
    const markup = mod.renderRoute(route);
    if (visibleText(markup).length < 200) fail(`${route.path} rendered no real text`);
    const html = mod.prerenderDocument({
      template,
      route,
      markup,
      stylesheets: route.bundle === 'home' ? homeCss : appCss,
    });
    const out = join(dist, route.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    process.stdout.write(`prerender: ${route.path} -> ${out}\n`);
  }

  const lastmod = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dist, 'sitemap.xml'), mod.sitemapXml(lastmod));

  // The shell must stay empty: app routes and unknown paths get it.
  if (readFileSync(shellPath, 'utf8') !== template || !template.includes('<div id="root"></div>')) {
    fail('dist/index.html is no longer the empty shell');
  }
  // The manifest was only for this script; it is not published.
  rmSync(join(dist, '.vite'), { recursive: true, force: true });
  rmSync(ssrOut, { recursive: true, force: true });
}

main().catch((err: unknown) =>
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err)),
);
