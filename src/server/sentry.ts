// Cloudflare Worker Sentry integration. Wired into actual Workers in PR 6+.
//
// This is a typed stub. Cloudflare Workers use @sentry/cloudflare, a different
// SDK from the frontend's @sentry/react. Installing @sentry/cloudflare and
// wiring real error reporting is deferred to PR 6, when the first Worker ships.
// Until then these exports give callers a stable surface that just logs.

import { logger } from '@/server/logger';

export function initSentryBackend(): void {
  // No-op until PR 6 installs @sentry/cloudflare and configures the first Worker.
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  logger.error('[sentry-backend stub] captureException', { error: String(err), ...context });
}
