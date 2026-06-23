import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from '@/App';
import { initSentry } from '@/lib/sentry';
import { TraceProvider } from '@/lib/trace-context';
import { initTheme } from '@/lib/theme';
import { initViewportLock } from '@/lib/viewport-lock';
import '@/index.css';

initSentry();
initTheme();
initViewportLock();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

function ErrorFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <span className="text-sm">Something went wrong. Refresh to try again.</span>
    </main>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <TraceProvider>
        <App />
      </TraceProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
