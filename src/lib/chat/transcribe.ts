// Pure, SDK-free voice-note transcription client. POSTs raw audio bytes to the
// transcribe Worker with a Bearer JWT and reads back a Whisper transcript. The
// fetcher is injected (the app passes fetchWithTrace, which attaches the trace
// header); tests pass a mock. Expected failures return a Result, never throw, so
// a missing or failed transcription degrades to "send without a transcript".

export type TranscribeResult = { ok: true; transcript: string } | { ok: false; message: string };

export interface TranscribeParams {
  blob: Blob;
  endpoint: string;
  token: string;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

const FAILURE_MESSAGE = 'Could not transcribe the voice note.';

export async function transcribeAudio(params: TranscribeParams): Promise<TranscribeResult> {
  try {
    const response = await params.fetcher(params.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.token}`,
        'content-type': params.blob.type !== '' ? params.blob.type : 'application/octet-stream',
      },
      body: params.blob,
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
  }
}
