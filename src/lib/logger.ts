import { captureException, setSentryTraceId } from '@/lib/sentry';

/**
 * Structured JSON logging for first-party frontend code.
 *
 * Every log line is a single-line JSON object carrying trace_id, level,
 * timestamp, message and context. Lines go to the browser console and are
 * shipped to Cloudflare Logpush (R2 sink) for Pages Functions; see
 * docs/cloudflare-logpush-setup.md.
 *
 * No console.* outside this file and src/server/logger.ts (ESLint enforces).
 * Only console.warn/console.error are permitted here, so debug/info also emit
 * via console.warn - the real level is carried in the JSON `level` field.
 *
 * trace_id is read from internal module state, not React context, so the
 * logger works in non-React code paths (fetch interceptors, plain modules).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  trace_id: string | null;
  env: 'development' | 'production';
  service: 'frontend';
  context?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key/i;
const MAX_DEPTH = 5;
const MAX_SIZE_BYTES = 8 * 1024;

let currentTraceId: string | null = null;

function setTraceId(traceId: string): void {
  currentTraceId = traceId;
}

function clearTraceId(): void {
  currentTraceId = null;
}

/**
 * Recursively replace values of secret-looking keys with "[REDACTED]".
 * Keys are matched case-insensitively at any depth up to MAX_DEPTH.
 */
function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(val, depth + 1);
  }
  return out;
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const env: 'development' | 'production' = import.meta.env.PROD ? 'production' : 'development';
  const redacted =
    context === undefined ? undefined : (redact(context, 1) as Record<string, unknown>);

  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    trace_id: currentTraceId,
    env,
    service: 'frontend',
  };
  if (redacted !== undefined) {
    line.context = redacted;
  }

  let serialized = JSON.stringify(line);
  const size = byteSize(serialized);
  if (size > MAX_SIZE_BYTES) {
    line.context = { truncated: true, original_size: size };
    serialized = JSON.stringify(line);
  }

  if (level === 'error') {
    console.error(serialized);
  } else {
    console.warn(serialized);
  }

  if (level === 'error' && env === 'production') {
    if (currentTraceId) {
      setSentryTraceId(currentTraceId);
    }
    captureException(new Error(message), redacted);
  }
}

export const logger = {
  setTraceId,
  clearTraceId,
  debug: (message: string, context?: Record<string, unknown>): void =>
    emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>): void =>
    emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>): void =>
    emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>): void =>
    emit('error', message, context),
};
