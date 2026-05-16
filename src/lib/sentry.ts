import * as Sentry from '@sentry/react';
import { env } from '@/lib/env';

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
    console.error('[sentry] captureException', err, context);
  }
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function setUser(user: { id: string; email: string }): void {
  Sentry.setUser(user);
}
