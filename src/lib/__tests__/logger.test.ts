import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { logger } from '@/lib/logger';

interface LogLine {
  ts: string;
  level: string;
  msg: string;
  trace_id: string | null;
  env: string;
  service: string;
  context?: Record<string, unknown>;
}

function lastLine(spy: MockInstance): LogLine {
  const calls = spy.mock.calls;
  const args = calls[calls.length - 1];
  if (!args) {
    throw new Error('expected a log line to have been emitted');
  }
  return JSON.parse(String(args[0])) as LogLine;
}

describe('logger', () => {
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.clearTraceId();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logger.clearTraceId();
  });

  it('emits structured JSON for info', () => {
    logger.info('hello');
    const line = lastLine(warnSpy);
    expect(line.level).toBe('info');
    expect(line.msg).toBe('hello');
    expect(line.service).toBe('frontend');
    expect(typeof line.ts).toBe('string');
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  it('redacts top-level secret keys', () => {
    logger.error('fail', { token: 'abc123' });
    const line = lastLine(errorSpy);
    expect(line.context?.token).toBe('[REDACTED]');
  });

  it('redacts nested secret keys', () => {
    logger.info('nested', { user: { api_key: 'x', name: 'ok' } });
    const line = lastLine(warnSpy);
    const user = line.context?.user as Record<string, unknown>;
    expect(user.api_key).toBe('[REDACTED]');
    expect(user.name).toBe('ok');
  });

  it('replaces oversized context with a truncated payload', () => {
    const huge = 'x'.repeat(100 * 1024);
    logger.info('big', { blob: huge });
    const line = lastLine(warnSpy);
    expect(line.context?.truncated).toBe(true);
    expect(typeof line.context?.original_size).toBe('number');
    expect(line.context?.blob).toBeUndefined();
  });

  it('propagates trace_id set via setTraceId', () => {
    logger.setTraceId('test-id');
    logger.info('with trace');
    expect(lastLine(warnSpy).trace_id).toBe('test-id');
  });

  it('reports trace_id as null after clearTraceId', () => {
    logger.setTraceId('test-id');
    logger.clearTraceId();
    logger.info('cleared');
    expect(lastLine(warnSpy).trace_id).toBeNull();
  });
});
