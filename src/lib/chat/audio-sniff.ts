// The truthful type of a recorded voice note, read from its bytes. Recorders
// do not always say what they wrote (WebKit can report '' or a type that does
// not match the container), and the upload Worker sniffs the magic bytes, so
// the File we send takes its type and name from the header: an EBML header
// (1A 45 DF A3) is webm, 'ftyp' at offset 4 is mp4; anything else keeps the
// recorder's own mimeType.
//
// The recorder's reported mimeType is remembered per File (a WeakMap, never
// persisted) so a permanent upload refusal can log it next to the sniffed
// type; a file restored from storage has none.

import { baseMime, recordingFileName } from '@/lib/chat/use-audio-recorder';

/** How many header bytes are read (and, on a refusal, logged). */
const HEADER_BYTES = 12;

const EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

/** The first HEADER_BYTES bytes of a blob; empty when they cannot be read. Never throws. */
export async function readHeader(blob: Blob): Promise<Uint8Array> {
  try {
    return new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return new Uint8Array(0);
  }
}

function matchesAt(header: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (header.length < offset + magic.length) return false;
  return magic.every((byte, i) => header[offset + i] === byte);
}

/**
 * The container a header names: 'audio/webm' for EBML, 'audio/mp4' for an
 * ftyp box, else the recorder's own type (its base mime, '' when it named
 * none). Pure.
 */
export function sniffAudioMime(header: Uint8Array, recorderMime: string): string {
  if (matchesAt(header, 0, EBML)) return 'audio/webm';
  if (matchesAt(header, 4, FTYP)) return 'audio/mp4';
  return baseMime(recorderMime);
}

/** Header bytes as lowercase hex, no separators. Pure. */
export function headerHex(header: Uint8Array): string {
  return Array.from(header.subarray(0, HEADER_BYTES), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** What a recording is sent as: the File's type and its matching name. */
interface VoiceFileType {
  type: string;
  name: string;
}

/**
 * The type and name for a recording: the sniffed type; when neither the
 * bytes nor the recorder name one, the recorder hook's base mime (its own
 * default). The name always follows the type. Pure.
 */
export function voiceFileType(
  header: Uint8Array,
  recorderMime: string,
  fallbackMime: string,
): VoiceFileType {
  const type = sniffAudioMime(header, recorderMime) || baseMime(fallbackMime);
  return { type, name: recordingFileName(type) };
}

const recorderMimes = new WeakMap<Blob, string>();

/** Remember what the recorder reported for this file (for the refusal log). */
export function rememberRecorderMime(file: Blob, recorderMime: string): void {
  recorderMimes.set(file, recorderMime);
}

/** The recorder's reported mimeType for a file sent this session; undefined otherwise. */
export function recorderMimeOf(file: Blob): string | undefined {
  return recorderMimes.get(file);
}
