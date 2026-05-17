import * as Sentry from '@sentry/react';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Initialize the Sentry browser SDK.
 *
 * No-op when VITE_SENTRY_DSN_FRONTEND is unset so local dev runs without
 * any Sentry configuration.
 */
export function initSentry(): void {
  const dsn = env.VITE_SENTRY_DSN_FRONTEND;
  if (!dsn) {
    return;
  }

  const options: Sentry.BrowserOptions = {
    dsn,
    environment: env.VITE_SENTRY_ENVIRONMENT,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [Sentry.browserTracingIntegration()],
  };

  if (env.VITE_SENTRY_RELEASE) {
    options.release = env.VITE_SENTRY_RELEASE;
  }

  Sentry.init(options);
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (import.meta.env.DEV) {
    logger.debug('[sentry] captureException', { error: String(err), ...context });
  }
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function setUser(user: { id: string; email: string }): void {
  Sentry.setUser(user);
}

/**
 * Tag every captured event with the active trace_id so Sentry errors are
 * searchable by trace_id. Called from TraceProvider whenever it changes.
 */
export function setSentryTraceId(traceId: string): void {
  Sentry.setTag('trace_id', traceId);
}
