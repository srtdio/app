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
  // /demo: the home bundle's own root, as src/main.tsx boots it.
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
    import('@/lib/motion'),
    import('@/lib/scroll-mode'),
  ]).then(
    ([
      { default: App },
      { TraceProvider },
      { initTheme },
      { initViewportLock },
      motion,
      { watchScrollDevice },
    ]) => {
      // Specs measure rest-state layout and take rest-state shots: the harness
      // runs with motion off (the app's own ?motion=0 switch, remembered for the
      // tab) unless a spec opens a page with ?motion=1.
      try {
        if (new URLSearchParams(window.location.search).get('motion') !== '1') {
          sessionStorage.setItem('sorted.motion', '0');
        }
      } catch {
        // Storage blocked: ?motion=0 on the URL still turns motion off.
      }
      motion.installMotionPreference();
      motion.watchUAVisualTransition();
      const { MotionRoot } = motion;
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
      watchScrollDevice();
      root.render(
        <StrictMode>
          <TraceProvider>
            <MotionRoot>
              <App />
            </MotionRoot>
          </TraceProvider>
        </StrictMode>,
      );
    },
  );
}
