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

export default defineConfig({
  plugins: [react(), ...sentryPlugins],
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
  },
});
