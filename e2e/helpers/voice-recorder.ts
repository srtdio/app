import type { Page } from '@playwright/test';

/**
 * The page's microphone and MediaRecorder, stubbed (no app hook): recording
 * starts at once and stop hands back one chunk of `recordedBytes` zero bytes
 * (audio/mp4). A blob of exactly `heldBytes` never reads back, so a recording
 * of that size keeps the composer in its voice-sending state (the file is
 * typed from its header before it is handed to the thread); any other size
 * reads, is sent and lands in the thread as an own voice note.
 */
export async function stubVoiceRecorder(
  page: Page,
  sizes: { heldBytes: number; recordedBytes: number },
): Promise<void> {
  await page.addInitScript(
    ({ heldBytes, recordedBytes }: { heldBytes: number; recordedBytes: number }) => {
      const held = new WeakSet<Blob>();
      const slice = Blob.prototype.slice;
      Blob.prototype.slice = function (this: Blob, ...args: Parameters<Blob['slice']>): Blob {
        const out = slice.apply(this, args);
        if (this.size === heldBytes) held.add(out);
        return out;
      };
      const arrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
        if (held.has(this) || this.size === heldBytes) {
          return new Promise<ArrayBuffer>(() => undefined);
        }
        return arrayBuffer.call(this);
      };
      class StubRecorder extends EventTarget {
        state: 'inactive' | 'recording' = 'inactive';
        readonly mimeType: string;
        constructor(_stream: unknown, options?: { mimeType?: string }) {
          super();
          this.mimeType = options?.mimeType ?? 'audio/mp4';
        }
        static isTypeSupported(type: string): boolean {
          return type === 'audio/mp4';
        }
        start(): void {
          this.state = 'recording';
        }
        requestData(): void {
          const event = new Event('dataavailable');
          Object.defineProperty(event, 'data', {
            value: new Blob([new Uint8Array(recordedBytes)], { type: this.mimeType }),
          });
          this.dispatchEvent(event);
        }
        stop(): void {
          if (this.state === 'inactive') return;
          this.requestData();
          this.state = 'inactive';
          this.dispatchEvent(new Event('stop'));
        }
      }
      Object.defineProperty(window, 'MediaRecorder', {
        value: StubRecorder,
        configurable: true,
        writable: true,
      });
      const stream = { getTracks: () => [{ stop: () => undefined }] };
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: () => Promise.resolve(stream),
          enumerateDevices: () => Promise.resolve([]),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
        configurable: true,
      });
    },
    sizes,
  );
}
