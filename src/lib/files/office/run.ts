// Runs one office parse in a fresh Web Worker (our own office.worker.ts, a
// Vite worker import): the main thread never parses a document. The Worker is
// terminated in a finally whatever happens: answer, time cap, the caller's
// abort, or a Worker error. The bytes are transferred, not copied.

import type { OfficeRequest, OfficeResponse } from './types';

/** The part of a Worker the runner uses (tests pass a fake). */
export interface OfficeWorkerLike {
  onmessage: ((event: MessageEvent<OfficeResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage(message: OfficeRequest, transfer: Transferable[]): void;
  terminate(): void;
}

function createOfficeWorker(): OfficeWorkerLike {
  return new Worker(new URL('./office.worker.ts', import.meta.url), {
    type: 'module',
    name: 'office',
  }) as unknown as OfficeWorkerLike;
}

interface RunOptions {
  op: OfficeRequest['op'];
  bytes: Uint8Array;
  mime: string | null;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  createWorker?: (() => OfficeWorkerLike) | undefined;
}

/** A buffer holding exactly `bytes`, safe to transfer. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/** Parse in a Worker. Resolves with the Worker's answer or a failure; never rejects. */
export function runOffice(options: RunOptions): Promise<OfficeResponse> {
  const { signal } = options;
  if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'aborted' });
  return new Promise<OfficeResponse>((resolve) => {
    let worker: OfficeWorkerLike | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (response: OfficeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
      if (worker !== null) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
      }
      resolve(response);
    };
    const onAbort = (): void => finish({ ok: false, reason: 'aborted' });
    try {
      worker = (options.createWorker ?? createOfficeWorker)();
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), options.timeoutMs);
      worker.onmessage = (event) => finish(event.data);
      worker.onerror = () => finish({ ok: false, reason: 'failed' });
      const buffer = ownBuffer(options.bytes);
      worker.postMessage({ op: options.op, bytes: buffer, mime: options.mime }, [buffer]);
    } catch {
      finish({ ok: false, reason: 'failed' });
    }
  });
}
