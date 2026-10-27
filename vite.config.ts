import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';

// Source map upload runs in CI only. SENTRY_AUTH_TOKEN and VITE_SENTRY_RELEASE
// are injected by the deploy workflow; a failed upload logs and continues so it
// never blocks the build.
const isCI = process.env.CI === 'true';

const sentryPlugins: PluginOption[] = isCI
  ? [
      sentryVitePlugin({
        org: 'srtdio',
        project: 'frontend',
        authToken: process.env.SENTRY_AUTH_TOKEN ?? '',
        sourcemaps: { assets: ['./dist/**'] },
        release: { name: process.env.VITE_SENTRY_RELEASE ?? '' },
        errorHandler: (err) => {
          console.warn('[sentry-vite-plugin] source map upload failed, continuing build:', err);
        },
      }),
    ]
  : [];

// Stable vendors get their own long-cached chunks, so an app code change does
// not change their hashes. Matched on the package directory under the last
// node_modules segment (pnpm nests packages under node_modules/.pnpm/...).
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'vendor-react',
    /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run[\\/]router|scheduler)[\\/]/,
  ],
  ['vendor-supabase', /[\\/]node_modules[\\/]@supabase[\\/]/],
  ['vendor-agora', /[\\/]node_modules[\\/]agora-chat[\\/]/],
  ['vendor-sentry', /[\\/]node_modules[\\/]@sentry(-internal)?[\\/]/],
  ['vendor-zod', /[\\/]node_modules[\\/]zod[\\/]/],
];

// dist/version.json names the build (src/lib/app-version.ts polls it so an
// open tab moves to a new deploy on its next navigation). Emitted only when CI
// sets VITE_APP_VERSION; local builds and dev have no version and no check.
const appVersion = process.env.VITE_APP_VERSION ?? '';
const versionFile: PluginOption = {
  name: 'srtd-version-file',
  apply: 'build',
  generateBundle() {
    if (appVersion === '') return;
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: `${JSON.stringify({ version: appVersion })}\n`,
    });
  },
};

function vendorChunk(id: string): string | undefined {
  return VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0];
}

export default defineConfig({
  plugins: [react(), versionFile, ...sentryPlugins],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@srtdio/schemas': fileURLToPath(new URL('./packages/schemas/src', import.meta.url)),
    },
  },
  build: {
    // Generate source maps for Sentry upload but do not reference them from the
    // shipped bundle.
    sourcemap: 'hidden',
    // scripts/prerender.ts reads the hashed CSS for each prerendered page from
    // the manifest, then deletes it from dist.
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
});
