import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from '@/App';
import { initSentry } from '@/lib/sentry';
import { TraceProvider } from '@/lib/trace-context';
import { initTheme } from '@/lib/theme';
import { initKeyboardViewport } from '@/lib/keyboard-viewport';
import { initViewportLock } from '@/lib/viewport-lock';
import { browserStaleDeployDeps, runStaleDeployGuard } from '@/lib/stale-deploy';
import '@/index.css';

initSentry();
initTheme();
initViewportLock();
initKeyboardViewport();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

function ErrorFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <span className="text-sm">Something went wrong. Refresh to try again.</span>
    </main>
  );
}

function render(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
        <TraceProvider>
          <App />
        </TraceProvider>
      </Sentry.ErrorBoundary>
    </StrictMode>,
  );
}

// Render only once the stylesheet is confirmed applied; on a stale deploy the
// guard reloads the page instead (at most once per session).
void runStaleDeployGuard(browserStaleDeployDeps()).then((shouldRender) => {
  if (shouldRender) render(rootElement);
});
