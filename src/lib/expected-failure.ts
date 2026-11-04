// Dependency-free helpers for reading thrown values: one describer that turns
// anything (Error, DOMException, MediaError, an SDK plain object, a string)
// into a small readable object, and one classifier for failures that are the
// network or the device, not a bug. Imported by logger.ts (which re-exports
// them) and by sentry.ts, which cannot import the logger's helpers without a
// cycle; it imports nothing, so the guest path pulls nothing new.

/** What the logger and Sentry see for a thrown value. Never "[object Object]". */
export interface ErrorDescription {
  name: string;
  message: string;
  code?: string | number;
  status?: string | number | boolean;
  type?: string | number;
}

/** Longest name or message kept, in characters. */
export const DESCRIBE_MAX_CHARS = 200;

function clip(text: string): string {
  return text.length > DESCRIBE_MAX_CHARS ? `${text.slice(0, DESCRIBE_MAX_CHARS)}…` : text;
}

/** A primitive the description may carry as code/status/type. */
function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

/** An object literal (or Object.create(null)), not a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * Describe any thrown value as { name, message, code?, status?, type? }, every
 * string capped at DESCRIBE_MAX_CHARS. Pure; never throws.
 */
export function describeError(value: unknown): ErrorDescription {
  if (typeof value === 'string') return { name: 'string', message: clip(value) };
  if (typeof value !== 'object' || value === null) {
    return { name: value === null ? 'null' : typeof value, message: clip(String(value)) };
  }
  const obj = value as Record<string, unknown>;
  const ctorName = (value as { constructor?: { name?: unknown } }).constructor?.name;
  const name =
    typeof obj.name === 'string' && obj.name !== ''
      ? obj.name
      : typeof ctorName === 'string' && ctorName !== ''
        ? ctorName
        : 'Object';
  let message = typeof obj.message === 'string' ? obj.message : '';
  if (message === '' && obj.data !== undefined) {
    message = typeof obj.data === 'string' ? obj.data : safeJson(obj.data);
  }
  if (message === '' && isPlainObject(value) && typeof obj.name !== 'string') {
    message = `Object with keys: ${Object.keys(obj).join(', ')}`;
  }
  const out: ErrorDescription = { name: clip(name), message: clip(message) };
  const code = scalar(obj.code);
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  const status = scalar(obj.status);
  if (status !== undefined) out.status = status;
  const type = scalar(obj.type);
  if (typeof type === 'string' || typeof type === 'number') out.type = type;
  return out;
}

/** describeError as one line ("Name: message"), for Result error messages. */
export function describeErrorText(value: unknown): string {
  const d = describeError(value);
  if (d.name === 'string') return d.message;
  return d.message === '' ? d.name : `${d.name}: ${d.message}`;
}

/** agora-chat's "socket is down" error type (status.d.ts WEBIM_CONNCTION_DISCONNECTED). */
const AGORA_DISCONNECTED_TYPE = 510;

/**
 * Exactly the agora-chat disconnect rejection: a plain object with no stack,
 * either { type: 510, message: 'websocket disconnected', ... } (the delivery
 * ack / send rejected by rejectMessage on disconnect) or { status: false } (a
 * call made while the socket is not open). Sentry drops only this shape.
 */
export function isAgoraDisconnect(value: unknown): boolean {
  if (!isPlainObject(value) || 'stack' in value) return false;
  if (value.type === AGORA_DISCONNECTED_TYPE && value.message === 'websocket disconnected') {
    return true;
  }
  return value.status === false;
}

/** fetch() network failures across engines (Chrome, Safari, Firefox, Node/RN). */
const FETCH_FAILURE =
  /Failed to fetch|Load failed|NetworkError when attempting to fetch resource|Network request failed|fetch failed/i;

/** A failure message (a Result error string) that names a timeout or network failure. */
const NETWORK_TEXT =
  /\b(TimeoutError|AbortError|NetworkError)\b|read timed out|request timed out|websocket disconnected|Failed to fetch|Load failed|Network request failed|fetch failed/i;

/** MediaError.MEDIA_ERR_NETWORK. */
const MEDIA_ERR_NETWORK = 2;

/** The device state a failure happened in; omitted fields are not checked. */
export interface FailureEnv {
  online?: boolean;
  visibility?: string;
}

/** The current device state, where there is one (browser); empty under Node. */
export function currentFailureEnv(): FailureEnv {
  const env: FailureEnv = {};
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    env.online = navigator.onLine;
  }
  if (typeof document !== 'undefined' && typeof document.visibilityState === 'string') {
    env.visibility = document.visibilityState;
  }
  return env;
}

/** The value alone (no device state) names a network, timeout or socket failure. */
function isNetworkShaped(value: unknown): boolean {
  if (typeof value === 'string') return NETWORK_TEXT.test(value);
  if (typeof value !== 'object' || value === null) return false;
  if (isPlainObject(value) && (value.status === false || value.type === AGORA_DISCONNECTED_TYPE)) {
    return true;
  }
  const obj = value as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof obj.name === 'string' ? obj.name : '';
  const message = typeof obj.message === 'string' ? obj.message : '';
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'NetworkError') return true;
  if (name === 'TypeError') return FETCH_FAILURE.test(message);
  const isMediaError =
    name === 'MediaError' || (typeof MediaError !== 'undefined' && value instanceof MediaError);
  return isMediaError && obj.code === MEDIA_ERR_NETWORK;
}

/**
 * Whether a failure is the network or the device, not a bug: the browser is
 * offline, the tab is hidden, a fetch TypeError, a TimeoutError or AbortError,
 * MediaError code 2 (network), agora-chat { status: false } or a type 510
 * object, or a failure message naming one of those. Logged as a warning.
 * `env` defaults to the current device state; pass {} to judge the value alone.
 */
export function isExpectedNetworkFailure(
  value: unknown,
  env: FailureEnv = currentFailureEnv(),
): boolean {
  if (env.online === false) return true;
  if (env.visibility === 'hidden') return true;
  return isNetworkShaped(value);
}
