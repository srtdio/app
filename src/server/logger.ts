/**
 * Structured JSON logging for Cloudflare Workers (backend).
 *
 * Stub: the interface matches the frontend logger (src/lib/logger.ts) so
 * callers have a stable surface. Workers capture console output to stdout,
 * which Cloudflare Logpush ships to the R2 sink (workers_trace_events
 * dataset); see docs/cloudflare-logpush-setup.md. Real Worker wiring lands
 * with the first Worker in a later PR.
 *
 * Only console.warn/console.error are permitted here (ESLint), so debug/info
 * also emit via console.warn - the real level is carried in the `level` field.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  trace_id: string | null;
  env: 'development' | 'production';
  service: 'backend';
  context?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key/i;
const MAX_DEPTH = 5;
const MAX_SIZE_BYTES = 8 * 1024;

// Workers run in the deployed environment; a real env signal is wired up when
// the first Worker ships.
const ENV: 'development' | 'production' = 'production';

let currentTraceId: string | null = null;

function setTraceId(traceId: string): void {
  currentTraceId = traceId;
}

function clearTraceId(): void {
  currentTraceId = null;
}

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
  const redacted =
    context === undefined ? undefined : (redact(context, 1) as Record<string, unknown>);

  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    trace_id: currentTraceId,
    env: ENV,
    service: 'backend',
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
