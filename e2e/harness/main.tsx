import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { isHomeBundlePath } from '@/components/home/guest-path';

// '/' is the smoke page. Every other path mounts the real app (App.tsx, the same
// provider and route tree as src/main.tsx) against fixture data that Playwright
// serves for the .test hosts in e2e/harness/stubs/env.ts. Sentry is never
// initialised here.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('harness root element missing');
const root = createRoot(rootEl);

if (window.location.pathname === '/') {
  // Mirror the app's dark mode switch (class on <html>) from the emulated
  // prefers-color-scheme so each Playwright project renders its theme.
  document.documentElement.classList.toggle(
    'dark',
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  root.render(
    <StrictMode>
      <div className="min-h-screen bg-panel p-4 font-sans text-fg">harness ok</div>
    </StrictMode>,
  );
} else if (isHomeBundlePath(window.location.pathname)) {
  // /pricing and /demo: the home bundle's own root, as src/main.tsx boots it.
  void import('@/components/home/HomeEntry').then(({ HomeEntry }) => {
    root.render(
      <StrictMode>
        <HomeEntry />
      </StrictMode>,
    );
  });
} else {
  void Promise.all([
    import('@/App'),
    import('@/lib/trace-context'),
    import('@/lib/theme'),
    import('@/lib/viewport-lock'),
  ]).then(([{ default: App }, { TraceProvider }, { initTheme }, { initViewportLock }]) => {
    // The app starts everyone in light and goes dark only by choice
    // (localStorage sorted-theme). The dark project stands in for a person who
    // chose dark, so seed that choice from the emulated colour scheme.
    try {
      localStorage.setItem(
        'sorted-theme',
        window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      );
    } catch {
      // Storage blocked: the harness renders light.
    }
    initTheme();
    initViewportLock();
    root.render(
      <StrictMode>
        <TraceProvider>
          <App />
        </TraceProvider>
      </StrictMode>,
    );
  });
}
