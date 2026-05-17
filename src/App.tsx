import { useNewTrace, useTraceId } from '@/lib/trace-context';
import { logger } from '@/lib/logger';

export default function App() {
  const traceId = useTraceId();
  const newTrace = useNewTrace();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-2 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <span>Sorted v2</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">DB: connected</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Edge: Cloudflare</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Errors: Sentry</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Trace: {traceId.slice(0, 8)}</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Logs: structured</span>
      {import.meta.env.DEV && (
        <button
          type="button"
          onClick={() => newTrace()}
          className="mt-2 min-h-[44px] min-w-[44px] rounded border border-zinc-300 px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
        >
          New trace
        </button>
      )}
      {import.meta.env.DEV && (
        <button
          type="button"
          onClick={() => {
            throw new Error('Sentry test error from button');
          }}
          className="min-h-[44px] min-w-[44px] rounded border border-zinc-300 px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
        >
          Test Sentry
        </button>
      )}
      {import.meta.env.DEV && (
        <button
          type="button"
          onClick={() => {
            logger.debug('test debug log', { step: 'debug' });
            logger.info('test info log', { step: 'info' });
            logger.warn('test warn log', { step: 'warn' });
            logger.error('test error log', {
              step: 'error',
              token: 'fake-secret-abc123',
            });
          }}
          className="min-h-[44px] min-w-[44px] rounded border border-zinc-300 px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
        >
          Test log levels
        </button>
      )}
    </main>
  );
}
