import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), setSentryTraceId: vi.fn() }));
vi.mock('@/lib/sentry', () => sentry);

import {
  describeContext,
  describeError,
  describeErrorText,
  isExpectedNetworkFailure,
  logger,
} from '@/lib/logger';
import { DESCRIBE_MAX_CHARS, isAgoraDisconnect } from '@/lib/expected-failure';

const VALUE_ONLY = {};

describe('describeError', () => {
  it('reads an Error and a DOMException', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      name: 'TypeError',
      message: 'Failed to fetch',
    });
    expect(describeError(new DOMException('took too long', 'TimeoutError'))).toEqual(
      expect.objectContaining({ name: 'TimeoutError', message: 'took too long', code: 23 }),
    );
  });

  it('reads a MediaError-like value with its code', () => {
    class MediaErrorLike {
      code = 2;
      message = 'MEDIA_ELEMENT_ERROR: network';
    }
    expect(describeError(new MediaErrorLike())).toEqual({
      name: 'MediaErrorLike',
      message: 'MEDIA_ELEMENT_ERROR: network',
      code: 2,
    });
  });

  it('reads the agora-chat plain objects (type, message, status, data)', () => {
    expect(describeError({ type: 510, message: 'websocket disconnected', data: {} })).toEqual({
      name: 'Object',
      message: 'websocket disconnected',
      type: 510,
    });
    expect(describeError({ status: false })).toEqual({
      name: 'Object',
      message: 'Object with keys: status',
      status: false,
    });
    expect(describeError({ type: 1, data: { error: 'bad' } })).toEqual({
      name: 'Object',
      message: '{"error":"bad"}',
      type: 1,
    });
  });

  it('reads strings and other primitives', () => {
    expect(describeError('boom')).toEqual({ name: 'string', message: 'boom' });
    expect(describeError(undefined)).toEqual({ name: 'undefined', message: 'undefined' });
    expect(describeError(null)).toEqual({ name: 'null', message: 'null' });
    expect(describeError(42)).toEqual({ name: 'number', message: '42' });
  });

  it('never yields "[object Object]" and caps every string', () => {
    for (const value of [{}, Object.create(null), { a: { b: 1 } }, new (class Foo {})()]) {
      expect(JSON.stringify(describeError(value))).not.toContain('[object Object]');
    }
    const long = describeError(new Error('x'.repeat(5_000)));
    expect(long.message.length).toBeLessThanOrEqual(DESCRIBE_MAX_CHARS + 1);
  });

  it('describeErrorText is one readable line', () => {
    expect(describeErrorText(new TypeError('Failed to fetch'))).toBe('TypeError: Failed to fetch');
    expect(describeErrorText('plain')).toBe('plain');
  });
});

describe('isExpectedNetworkFailure', () => {
  it('is true for each expected network or device failure', () => {
    const timeout = new DOMException('t', 'TimeoutError');
    const abort = new DOMException('a', 'AbortError');
    for (const value of [
      new TypeError('Failed to fetch'),
      new TypeError('Load failed'),
      new TypeError('NetworkError when attempting to fetch resource.'),
      timeout,
      abort,
      { name: 'MediaError', code: 2 },
      { status: false },
      { type: 510, message: 'websocket disconnected', data: {} },
      { type: 510, message: 'anything' },
      'listChannelClears: TypeError: Failed to fetch',
      'read timed out',
    ]) {
      expect(isExpectedNetworkFailure(value, VALUE_ONLY)).toBe(true);
    }
  });

  it('is true for anything while offline or hidden', () => {
    const bug = new Error('x is undefined');
    expect(isExpectedNetworkFailure(bug, { online: false })).toBe(true);
    expect(isExpectedNetworkFailure(bug, { visibility: 'hidden' })).toBe(true);
    expect(isExpectedNetworkFailure(bug, { online: true, visibility: 'visible' })).toBe(false);
  });

  it('is false for bugs and server errors', () => {
    for (const value of [
      new TypeError('x is undefined'),
      new Error('boom'),
      { name: 'MediaError', code: 4 },
      { type: 206, message: 'login another device' },
      { status: true },
      'listChannelSummaries: permission denied for table chat_channels',
      'upstream 503',
      undefined,
    ]) {
      expect(isExpectedNetworkFailure(value, VALUE_ONLY)).toBe(false);
    }
  });

  it('isAgoraDisconnect matches only the exact disconnect shapes', () => {
    expect(isAgoraDisconnect({ type: 510, message: 'websocket disconnected', data: {} })).toBe(
      true,
    );
    expect(isAgoraDisconnect({ status: false })).toBe(true);
    expect(isAgoraDisconnect({ type: 510, message: 'other' })).toBe(false);
    expect(isAgoraDisconnect({ type: 510, message: 'websocket disconnected', stack: 's' })).toBe(
      false,
    );
    expect(
      isAgoraDisconnect(Object.assign(new Error('websocket disconnected'), { type: 510 })),
    ).toBe(false);
  });
});

describe('logger context', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  beforeEach(() => {
    warn.mockClear();
  });
  afterAll(() => {
    warn.mockRestore();
  });

  it('describeContext turns Errors and class instances into plain fields; plain values pass', () => {
    const out = describeContext({
      error: new TypeError('Failed to fetch'),
      plain: { a: 1 },
      list: [1, 2],
      text: 'x',
    });
    expect(out).toEqual({
      error: { name: 'TypeError', message: 'Failed to fetch' },
      plain: { a: 1 },
      list: [1, 2],
      text: 'x',
    });
  });

  it('an Error context value is logged readably, not as {}', () => {
    logger.warn('chat: something failed', { error: new TypeError('Load failed') });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as { context: unknown };
    expect(line.context).toEqual({ error: { name: 'TypeError', message: 'Load failed' } });
  });

  it('redaction still applies after describing', () => {
    logger.warn('x', { token: 'secret', nested: { api_key: 'k' } });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as { context: unknown };
    expect(line.context).toEqual({ token: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
  });
});
