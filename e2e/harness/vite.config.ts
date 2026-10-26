import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import appTailwindConfig from '../../tailwind.config.ts';

// Visual test harness for Playwright WebKit. Separate Vite root so it never
// joins the app build or routing. Reuses the app's Tailwind config, PostCSS
// plugins, and src/index.css so tokens and fonts match the app.
const harnessRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: harnessRoot,
  envDir: harnessRoot,
  envPrefix: 'HARNESS_',
  // The app's own static files (the first post's sample photo).
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  plugins: [react()],
  // The homepage renders its clips only with a media base. Specs route this
  // path themselves (see home-pages.spec.ts), so nothing is fetched for real.
  define: {
    'import.meta.env.VITE_SITE_MEDIA_URL': JSON.stringify('http://localhost:4178/site-media'),
    // Link previews: e2e/fixtures/link-previews.ts stubs this Worker host.
    'import.meta.env.VITE_LINK_PREVIEW_URL': JSON.stringify('https://link-preview.harness.test'),
  },
  resolve: {
    // Harness-only fixture aliases. Order matters: the exact-match stubs come
    // before the '@' prefix alias. Never mirrored in vitest.
    alias: [
      { find: /^@\/lib\/env$/, replacement: `${harnessRoot}stubs/env.ts` },
      { find: /^agora-chat$/, replacement: `${harnessRoot}stubs/agora-chat.ts` },
      { find: '@', replacement: fileURLToPath(new URL('../../src', import.meta.url)) },
    ],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...appTailwindConfig,
          content: {
            relative: false,
            files: [
              `${repoRoot}/index.html`,
              `${repoRoot}/src/**/*.{ts,tsx}`,
              `${harnessRoot}/**/*.{html,ts,tsx}`,
            ],
          },
        }),
        autoprefixer(),
      ],
    },
  },
  // fflate is reached only from the office Worker (src/lib/files/office/zip.ts),
  // which the dep scan does not follow. Found late, it re-optimizes and reloads
  // every open page, failing whichever spec runs beside the first office open.
  optimizeDeps: {
    include: ['fflate'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
