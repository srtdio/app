// Pure, SDK-free voice-note transcription client. POSTs { url } (the voice
// note's presigned R2 URL, the one the player already holds) to the transcribe
// Worker with a Bearer JWT; the Worker fetches the audio itself and returns a
// Whisper transcript. The browser never downloads the audio for this. The
// fetcher is injected (the app passes fetchWithTrace, which attaches the trace
// header); tests pass a mock. Expected failures return a Result, never throw, so
// a failed or timed-out tap reads "Transcript not available" and nothing else.

/** A tap-to-transcribe request is aborted after this long. */
export const TRANSCRIBE_TIMEOUT_MS = 20_000;

export type TranscribeResult = { ok: true; transcript: string } | { ok: false; message: string };

export interface TranscribeParams {
  /** The voice note's presigned R2 GET URL. */
  url: string;
  endpoint: string;
  token: string;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  /** Abort after this long; defaults to TRANSCRIBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

const FAILURE_MESSAGE = "Couldn't transcribe the voice note. Try again.";

export async function transcribeAudio(params: TranscribeParams): Promise<TranscribeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await params.fetcher(params.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: params.url }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, message: FAILURE_MESSAGE };
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { ok?: unknown }).ok === true &&
      typeof (body as { transcript?: unknown }).transcript === 'string'
    ) {
      return { ok: true, transcript: (body as { transcript: string }).transcript };
    }
    return { ok: false, message: FAILURE_MESSAGE };
  } catch {
    return { ok: false, message: FAILURE_MESSAGE };
  } finally {
    clearTimeout(timer);
  }
}
