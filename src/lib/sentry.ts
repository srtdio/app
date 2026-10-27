import type { BrowserOptions } from '@sentry/react';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// Lazy facade over the Sentry browser SDK. This module imports only types
// from @sentry/react statically, so the logger, TraceProvider and the local error
// boundaries can import it without pulling vendor-sentry into the boot set.
// initSentry() loads the SDK; reports made before it is ready wait in a small
// capped queue and are sent once it initialises, unchanged afterwards.

type SentrySdk = Pick<typeof import('@sentry/react'), 'captureException' | 'setTag'>;
type PendingReport = readonly [err: unknown, context: Record<string, unknown> | undefined];

export const MAX_PENDING_REPORTS = 20;

let sdk: SentrySdk | null = null;
let loading: Promise<boolean> | null = null;
let traceIdTag: string | null = null;
const pending: PendingReport[] = [];

async function loadSentry(dsn: string): Promise<boolean> {
  // Destructured where it is imported so Rollup can still tree-shake the SDK.
  const { init, browserTracingIntegration, captureException, setTag } =
    await import('@sentry/react');

  const options: BrowserOptions = {
    dsn,
    environment: env.VITE_SENTRY_ENVIRONMENT,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [browserTracingIntegration()],
  };

  if (env.VITE_SENTRY_RELEASE) {
    options.release = env.VITE_SENTRY_RELEASE;
  }

  init(options);
  sdk = { captureException, setTag };
  if (traceIdTag) setTag('trace_id', traceIdTag);
  for (const [err, context] of pending.splice(0)) {
    captureException(err, context ? { extra: context } : undefined);
  }
  return true;
}

/**
 * Load and initialise the Sentry browser SDK (once). Resolves true when Sentry
 * is live, false when it is not configured or failed to load.
 *
 * No-op when VITE_SENTRY_DSN_FRONTEND is unset so local dev runs without
 * any Sentry configuration.
 */
export function initSentry(): Promise<boolean> {
  if (!loading) {
    const dsn = env.VITE_SENTRY_DSN_FRONTEND;
    if (!dsn) {
      pending.length = 0;
      loading = Promise.resolve(false);
    } else {
      loading = loadSentry(dsn).catch(() => {
        pending.length = 0;
        return false;
      });
    }
  }
  return loading;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (import.meta.env.DEV) {
    logger.debug('[sentry] captureException', { error: String(err), ...context });
  }
  if (sdk) {
    sdk.captureException(err, context ? { extra: context } : undefined);
    return;
  }
  if (!env.VITE_SENTRY_DSN_FRONTEND) return;
  if (pending.length < MAX_PENDING_REPORTS) pending.push([err, context]);
}

/**
 * Tag every captured event with the active trace_id so Sentry errors are
 * searchable by trace_id. Called from TraceProvider whenever it changes; a tag
 * set before the SDK loads is applied when it initialises.
 */
export function setSentryTraceId(traceId: string): void {
  traceIdTag = traceId;
  sdk?.setTag('trace_id', traceId);
}
