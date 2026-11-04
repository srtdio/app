// The file status probe for a voice note whose play failed with a MediaError.
// Safari reports a missing or refused file as MediaError 4 (not supported), the
// same code as a bad codec, so one tiny ranged GET on the same-origin file link
// (srtd.io/f/...) says which it was: the HTTP status, or 'network' when the
// fetch itself failed. Cross-origin urls (plain presigns) are never probed.
// Runs only after a play attempt already failed, never on a first play.

import { fetchWithTrace } from '@/lib/fetch';

/** The probe's answer: an HTTP status, 'network' (fetch rejected), or 'skipped'. */
export type VoiceProbeStatus = number | 'network' | 'skipped';

/** The probe's time limit; past it the probe reads as 'network'. */
export const VOICE_PROBE_TIMEOUT_MS = 5_000;

/** Statuses that mean the file is missing, refused or the server failed. */
const BAD_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/**
 * Whether `url` is an http(s) url on `origin` (relative urls resolve against
 * it). blob:, data: and any other origin are not. Pure.
 */
export function isProbeableUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

/** Whether a probe status means the file is gone, refused, or the server failed. Pure. */
export function isBadProbeStatus(status: VoiceProbeStatus | undefined): boolean {
  if (typeof status !== 'number') return false;
  return BAD_STATUSES.has(status) || status >= 500;
}

/**
 * Probe `url` once: GET with Range bytes=0-1 and a 5 s limit, read only the
 * status and cancel the body. Never throws. A cross-origin url is 'skipped'.
 */
export async function probeVoiceUrl(
  url: string,
  origin: string = typeof location === 'undefined' ? '' : location.origin,
  fetcher: typeof fetchWithTrace = fetchWithTrace,
): Promise<VoiceProbeStatus> {
  if (origin === '' || !isProbeableUrl(url, origin)) return 'skipped';
  try {
    const res = await fetcher(
      url,
      { method: 'GET', headers: { Range: 'bytes=0-1' }, cache: 'no-store' },
      undefined,
      { timeoutMs: VOICE_PROBE_TIMEOUT_MS },
    );
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return 'network';
  }
}
