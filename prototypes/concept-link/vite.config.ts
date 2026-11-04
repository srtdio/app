// Prototype-only Vite config: link a post to an approved plan concept.
// Root is this folder, '@' resolves to the app's src, and Tailwind runs on the
// app's own tailwind.config.ts with this folder added to its content globs.
// Not referenced by the app's vite.config.ts, index.html or any route, so it
// never enters the production build.
// Run: pnpm exec vite --config prototypes/concept-link/vite.config.ts

import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import appTailwind from '../../tailwind.config';

const here = fileURLToPath(new URL('.', import.meta.url));
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const appSrc = fileURLToPath(new URL('../../src', import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: { '@': appSrc },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...appTailwind,
          content: [`${appSrc}/**/*.{ts,tsx}`, `${here}**/*.{ts,tsx,html}`],
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [appRoot] },
  },
});
