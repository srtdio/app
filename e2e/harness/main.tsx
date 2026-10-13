import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';

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
} else {
  void Promise.all([
    import('@/App'),
    import('@/lib/trace-context'),
    import('@/lib/theme'),
    import('@/lib/viewport-lock'),
  ]).then(([{ default: App }, { TraceProvider }, { initTheme }, { initViewportLock }]) => {
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
