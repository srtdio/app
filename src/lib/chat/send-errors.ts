// One pure classifier for why a chat send attempt failed. It decides the only
// thing the outbox needs to know: keep trying (transient, the bubble keeps its
// clock) or stop and show "Not sent" + Retry (permanent, the server refused
// this message and repeating it would be refused again).
//
// Permanent: the record RPC answered with a Postgres / PostgREST error code
// (a proc RAISE such as P0001, a permission refusal 42501, a check violation
// 23514, "forward source not accessible", other validation), or the upload
// Worker refused the request: any 4xx but 408 / 429 (401 only after one
// session refresh and retry), or a refusal of the file itself (size, type,
// contents, virus).
// Transient: everything else. A network error, a fetch abort or timeout, HTTP
// 408 / 429 / 5xx, offline (status 0), an upload XHR error, abort or stall, a
// connection-class SQLSTATE (08, 40, 53, 57), an expired JWT (PGRST30x, the
// session refreshes) and a function missing from the schema cache (PGRST202,
// a deploy in progress). Unknown is transient: a message is never given up on
// because of a failure we cannot name.

import { uploadErrorMessage } from '@/lib/asset-upload';

export type SendErrorClass = 'transient' | 'permanent';

/** A failed record attempt as record.ts reports it. */
export interface RecordFailure {
  /** 'timeout' when our own abort timer fired. */
  reason?: 'timeout' | 'error';
  /** The PostgREST error code (a SQLSTATE or PGRSTxxx); '' or absent on a transport failure. */
  code?: string | null;
  /** The HTTP status; 0 when the request never got an answer. */
  status?: number | null;
  message: string;
}

/** Proc text the server raises when a forward's source is not readable by the caller. */
const FORWARD_REFUSAL = /forward source not accessible/i;

/** SQLSTATE classes that describe the server's condition, not this message. */
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '40', '53', '57']);

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** Classify one failed record attempt. Pure. */
export function classifyRecordFailure(failure: RecordFailure): SendErrorClass {
  if (failure.reason === 'timeout') return 'transient';
  const status = failure.status ?? null;
  if (status !== null && isTransientStatus(status)) return 'transient';
  if (FORWARD_REFUSAL.test(failure.message)) return 'permanent';
  const code = (failure.code ?? '').trim();
  if (/^PGRST30\d$/.test(code) || code === 'PGRST202') return 'transient';
  if (/^PGRST\d{3}$/.test(code)) return 'permanent';
  // A SQLSTATE: five uppercase alphanumerics, always with a digit.
  if (/^[0-9A-Z]{5}$/.test(code) && /\d/.test(code)) {
    return TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2)) ? 'transient' : 'permanent';
  }
  return 'transient';
}

/** The upload Worker's refusals of the file itself, by their Result copy. */
const PERMANENT_UPLOAD_MESSAGES: ReadonlySet<string> = new Set(
  ['file_too_large', 'unsupported_mime', 'mime_mismatch', 'virus_detected'].map(uploadErrorMessage),
);

/**
 * Classify one failed attachment upload by its Result copy and, when the
 * request got an answer, the upload's HTTP status. A refusal copy is
 * permanent whatever the status; 0 (no answer, abort, stall), 408, 429 and
 * 5xx are transient; any other 4xx is permanent (a 401 reaches here only
 * after the session refresh and one retry). No status: transient. Pure.
 */
export function classifyUploadFailure(message: string, status?: number | null): SendErrorClass {
  if (PERMANENT_UPLOAD_MESSAGES.has(message)) return 'permanent';
  if (status === undefined || status === null) return 'transient';
  if (isTransientStatus(status)) return 'transient';
  if (status >= 400 && status < 500) return 'permanent';
  return 'transient';
}

/** Plain words for a message the server refused for good (not a file refusal). */
export const RECORD_REFUSED = "This message can't be sent.";
/** Plain words for a file the upload Worker refused without a known reason. */
export const UPLOAD_REFUSED = "This file can't be sent.";

/**
 * The reason a permanently refused send shows under its bubble, in plain
 * words: an upload refusal's own copy when it names the file's problem
 * (size, type, contents, virus and the other safety refusals), else a
 * generic line for the stage that refused it. Pure.
 */
export function refusalReason(stage: 'upload' | 'record', error: string): string {
  if (stage === 'upload') return UPLOAD_CODE_BY_MESSAGE.has(error) ? error : UPLOAD_REFUSED;
  return RECORD_REFUSED;
}

/** The HTTP status a failed chat upload carries (use-chat-attachments adds it), if any. */
export function uploadFailureStatus(result: { ok: false; message: string }): number | undefined {
  const status = (result as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The upload Worker codes whose Result copy is recognisable, by that copy,
 * including the file-safety refusals. Logging only: classification above is
 * unchanged.
 */
const UPLOAD_CODE_BY_MESSAGE: ReadonlyMap<string, string> = new Map(
  [
    'file_too_large',
    'unsupported_mime',
    'mime_mismatch',
    'virus_detected',
    'blocked_type',
    'encrypted_file',
    'embedded_content',
    'archive_limits',
    'external_content',
  ].map((code) => [uploadErrorMessage(code), code]),
);

/**
 * The Worker's error code behind a failed upload's Result copy: the refusal
 * codes are recognised; any other copy (a generic 4xx) reads 'unknown'. Pure.
 */
export function uploadFailureCode(message: string): string {
  return UPLOAD_CODE_BY_MESSAGE.get(message) ?? 'unknown';
}

/**
 * The one log line for a permanently refused upload: why it was refused and
 * what was sent, never what it said. Only these keys, no file name, no audio
 * beyond the header bytes as hex. Pure.
 */
export type UploadRefusalContext = {
  status: number | null;
  code: string;
  mime: string;
  size: number;
  recorder_mime: string | null;
  header_hex: string;
  user_agent: string;
};

export function uploadRefusalContext(input: {
  message: string;
  status: number | undefined;
  mime: string;
  size: number;
  recorderMime: string | undefined;
  headerHex: string;
  userAgent: string;
}): UploadRefusalContext {
  return {
    status: input.status ?? null,
    code: uploadFailureCode(input.message),
    mime: input.mime,
    size: input.size,
    recorder_mime: input.recorderMime ?? null,
    header_hex: input.headerHex,
    user_agent: input.userAgent,
  };
}
