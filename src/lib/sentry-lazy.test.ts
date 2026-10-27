// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  initSentry: vi.fn(() => Promise.resolve(true)),
  captureException: vi.fn(),
}));
vi.mock('@/lib/sentry', () => sentry);

async function freshLazy(): Promise<typeof import('@/lib/sentry-lazy')> {
  vi.resetModules();
  return import('@/lib/sentry-lazy');
}

function throwUncaught(err: Error): void {
  window.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }));
}

function rejectUnhandled(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

async function runIdle(lazy: typeof import('@/lib/sentry-lazy')): Promise<void> {
  lazy.scheduleSentry();
  await vi.waitFor(() => expect(sentry.initSentry).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  sentry.initSentry.mockImplementation(() => Promise.resolve(true));
  (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback = (cb) => {
    cb();
    return 0;
  };
});

afterEach(() => {
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
});

describe('sentry-lazy', () => {
  it('forwards errors from before init once, then stops listening', async () => {
    const lazy = await freshLazy();
    lazy.captureEarlyErrors();
    const early = new Error('early');
    throwUncaught(early);
    rejectUnhandled('rejected');
    expect(sentry.captureException).not.toHaveBeenCalled();

    await runIdle(lazy);
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledWith(early, { before_sentry_init: true });
    expect(sentry.captureException).toHaveBeenCalledWith('rejected', { before_sentry_init: true });

    throwUncaught(new Error('after'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it('caps the early queue', async () => {
    const lazy = await freshLazy();
    lazy.captureEarlyErrors();
    for (let i = 0; i < lazy.MAX_EARLY_ERRORS + 5; i += 1) throwUncaught(new Error(`e${i}`));
    await runIdle(lazy);
    expect(sentry.captureException).toHaveBeenCalledTimes(lazy.MAX_EARLY_ERRORS);
  });

  it('drops the queue when Sentry is not configured', async () => {
    sentry.initSentry.mockImplementation(() => Promise.resolve(false));
    const lazy = await freshLazy();
    lazy.captureEarlyErrors();
    throwUncaught(new Error('early'));
    await runIdle(lazy);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
