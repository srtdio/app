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

describe('dropNoise (beforeSend)', () => {
  type Event = Parameters<typeof import('@/lib/sentry').dropNoise>[0];
  const event = (ex: Record<string, unknown>): Event =>
    ({ type: undefined, exception: { values: [ex] } }) as unknown as Event;
  const agoraFrames = {
    frames: [
      { filename: 'app:///node_modules/agora-chat/Easemob-chat.js' },
      { filename: 'https://srtdio-app.pages.dev/assets/vendor-agora-AbC123.js' },
    ],
  };

  it('is wired as beforeSend on init', async () => {
    const sentry = await freshSentry();
    await sentry.initSentry();
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({ beforeSend: sentry.dropNoise }),
    );
  });

  it('drops the browsing-context AbortError (FRONTEND-D)', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({
      type: 'AbortError',
      value: 'Promise was rejected because the browsing context is going away',
    });
    expect(dropNoise(e)).toBeNull();
  });

  it('drops an unhandled rejection with only agora-chat frames (FRONTEND-B)', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({
      type: 'TypeError',
      value: 'this._msgHash[...] is undefined',
      mechanism: { type: 'onunhandledrejection', handled: false },
      stacktrace: agoraFrames,
    });
    expect(dropNoise(e)).toBeNull();
  });

  it('keeps a normal Error', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({
      type: 'Error',
      value: 'boom',
      mechanism: { type: 'generic', handled: true },
      stacktrace: { frames: [{ filename: 'https://srtdio-app.pages.dev/assets/index-1.js' }] },
    });
    expect(dropNoise(e)).toBe(e);
  });

  it('keeps an agora rejection with a first-party frame', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({
      type: 'TypeError',
      value: 'this._msgHash[...] is undefined',
      mechanism: { type: 'onunhandledrejection', handled: false },
      stacktrace: {
        frames: [
          ...agoraFrames.frames,
          { filename: 'https://srtdio-app.pages.dev/assets/ChatConnected-9.js' },
        ],
      },
    });
    expect(dropNoise(e)).toBe(e);
  });

  const rejection = (keys: string): Event =>
    event({
      type: 'UnhandledRejection',
      value: `Object captured as promise rejection with keys: ${keys}`,
      mechanism: { type: 'onunhandledrejection', handled: false },
    });
  const withSerialized = (e: Event, reason: unknown): Event => {
    (e as unknown as { extra: unknown }).extra = { __serialized__: reason };
    return e;
  };

  it('drops the agora-chat 510 websocket disconnected rejection (FRONTEND-3)', async () => {
    const { dropNoise } = await freshSentry();
    const reason = { type: 510, message: 'websocket disconnected', data: {} };
    expect(dropNoise(rejection('data, message, type'), { originalException: reason })).toBeNull();
    // Without a hint, Sentry's serialised copy of the object is read instead.
    expect(dropNoise(withSerialized(rejection('data, message, type'), reason))).toBeNull();
  });

  it('drops the agora-chat { status: false } rejection (socket not open)', async () => {
    const { dropNoise } = await freshSentry();
    expect(dropNoise(rejection('status'), { originalException: { status: false } })).toBeNull();
  });

  it('keeps every other no-stack plain-object rejection', async () => {
    const { dropNoise } = await freshSentry();
    for (const reason of [
      { type: 510, message: 'something else', data: {} },
      { type: 206, message: 'user login another device' },
      { type: 39, message: 'websocket disconnected' },
      { status: true },
      { message: 'boom' },
    ]) {
      const e = rejection(Object.keys(reason).join(', '));
      expect(dropNoise(e, { originalException: reason })).toBe(e);
    }
    const e = withSerialized(rejection('data, message, type'), { type: 1, message: 'x' });
    expect(dropNoise(e)).toBe(e);
  });

  it('keeps an Error rejection even with the disconnect message', async () => {
    const { dropNoise } = await freshSentry();
    const err = Object.assign(new Error('websocket disconnected'), { type: 510 });
    const e = event({
      type: 'Error',
      value: 'websocket disconnected',
      mechanism: { type: 'onunhandledrejection', handled: false },
    });
    expect(dropNoise(e, { originalException: err })).toBe(e);
  });

  it('keeps the disconnect shape when it is not an unhandled rejection', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({
      type: 'Error',
      value: 'captured',
      mechanism: { type: 'generic', handled: true },
    });
    expect(dropNoise(e, { originalException: { status: false } })).toBe(e);
  });

  it('keeps an AbortError for any other reason', async () => {
    const { dropNoise } = await freshSentry();
    const e = event({ type: 'AbortError', value: 'The user aborted a request.' });
    expect(dropNoise(e)).toBe(e);
  });
});
