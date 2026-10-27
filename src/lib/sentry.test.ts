import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  captureException: vi.fn(),
  setTag: vi.fn(),
}));
const env = vi.hoisted(() => ({
  VITE_SENTRY_DSN_FRONTEND: 'https://key@o0.ingest.sentry.io/0' as string | undefined,
  VITE_SENTRY_ENVIRONMENT: 'test',
  VITE_SENTRY_RELEASE: undefined as string | undefined,
}));
vi.mock('@sentry/react', () => sdk);
vi.mock('@/lib/env', () => ({ env }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn() } }));

async function freshSentry(): Promise<typeof import('@/lib/sentry')> {
  vi.resetModules();
  return import('@/lib/sentry');
}

beforeEach(() => {
  vi.clearAllMocks();
  env.VITE_SENTRY_DSN_FRONTEND = 'https://key@o0.ingest.sentry.io/0';
});

describe('sentry facade', () => {
  it('queues reports made before init and forwards them once, on init', async () => {
    const sentry = await freshSentry();
    const err = new Error('early');
    sentry.captureException(err, { where: 'boot' });
    sentry.setSentryTraceId('trace-1');
    expect(sdk.captureException).not.toHaveBeenCalled();

    await expect(sentry.initSentry()).resolves.toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.setTag).toHaveBeenCalledWith('trace_id', 'trace-1');
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledWith(err, { extra: { where: 'boot' } });

    await sentry.initSentry();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it('caps the pre-init queue', async () => {
    const sentry = await freshSentry();
    for (let i = 0; i < sentry.MAX_PENDING_REPORTS + 5; i += 1) {
      sentry.captureException(new Error(`e${i}`));
    }
    await sentry.initSentry();
    expect(sdk.captureException).toHaveBeenCalledTimes(sentry.MAX_PENDING_REPORTS);
  });

  it('reports after init go straight to Sentry, unchanged', async () => {
    const sentry = await freshSentry();
    await sentry.initSentry();
    const err = new Error('late');
    sentry.captureException(err, { a: 1 });
    sentry.captureException(err);
    expect(sdk.captureException).toHaveBeenNthCalledWith(1, err, { extra: { a: 1 } });
    expect(sdk.captureException).toHaveBeenNthCalledWith(2, err, undefined);
    sentry.setSentryTraceId('trace-2');
    expect(sdk.setTag).toHaveBeenCalledWith('trace_id', 'trace-2');
  });

  it('does not load the SDK when no DSN is set', async () => {
    env.VITE_SENTRY_DSN_FRONTEND = undefined;
    const sentry = await freshSentry();
    sentry.captureException(new Error('x'));
    await expect(sentry.initSentry()).resolves.toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});
