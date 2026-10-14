// A bounded ZIP reader for OOXML packages, run inside the office Worker only.
//
// The central directory is parsed here (bounds checked against the buffer);
// fflate's streaming Inflate decompresses one entry at a time, fed 16 KiB per
// push, so a zip bomb stops within one chunk of the output cap instead of
// allocating whatever the archive claims. ZIP64, encrypted entries and any
// method but stored/deflate are refused.

import { Inflate } from 'fflate';

export class ZipError extends Error {
  constructor(
    message: string,
    readonly code: 'corrupt' | 'locked' | 'too_large',
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRIES = 10_000;
const PUSH_CHUNK = 16 * 1024;

function u16(b: Uint8Array, at: number): number {
  if (at < 0 || at + 2 > b.length) throw new ZipError('read past end', 'corrupt');
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > b.length) throw new ZipError('read past end', 'corrupt');
  return (
    ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) +
    (b[at + 3] ?? 0) * 0x1000000
  );
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Read the central directory into a name -> entry map. Throws ZipError. */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  // The end record sits in the last 22 + 65535 bytes (its comment is at most 64 KiB).
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipError('no end of central directory', 'corrupt');
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('zip64 not supported', 'corrupt');
  }
  if (count > MAX_ENTRIES) throw new ZipError('too many entries', 'too_large');
  if (cdOffset + cdSize > eocd) throw new ZipError('central directory out of range', 'corrupt');

  const entries = new Map<string, ZipEntry>();
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== CD_SIG) throw new ZipError('bad central directory entry', 'corrupt');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    if (at + 46 + nameLen > bytes.length) throw new ZipError('name past end', 'corrupt');
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen)).replace(/^\/+/, '');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64 not supported', 'corrupt');
    }
    if (!entries.has(name)) {
      entries.set(name, { name, method, flags, compressedSize, size, localOffset });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * One entry's bytes, at most `maxBytes` (declared and actual). Stored or
 * deflate only; encrypted entries are 'locked'. Throws ZipError.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Uint8Array {
  if ((entry.flags & 0x1) !== 0) throw new ZipError('encrypted entry', 'locked');
  if (entry.size > maxBytes) throw new ZipError('entry too large', 'too_large');
  if (u32(bytes, entry.localOffset) !== LOCAL_SIG)
    throw new ZipError('bad local header', 'corrupt');
  const start =
    entry.localOffset +
    30 +
    u16(bytes, entry.localOffset + 26) +
    u16(bytes, entry.localOffset + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError('entry past end', 'corrupt');
  const data = bytes.subarray(start, end);
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new ZipError('stored size mismatch', 'corrupt');
    return data.slice();
  }
  if (entry.method !== 8) throw new ZipError('unsupported compression', 'corrupt');

  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inflate = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > maxBytes) throw new ZipError('entry inflates past cap', 'too_large');
    chunks.push(chunk);
    if (final) done = true;
  });
  try {
    for (let i = 0; i < data.length; i += PUSH_CHUNK) {
      inflate.push(data.subarray(i, i + PUSH_CHUNK), i + PUSH_CHUNK >= data.length);
    }
    if (data.length === 0) inflate.push(new Uint8Array(0), true);
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('inflate failed', 'corrupt');
  }
  if (!done || total !== entry.size) throw new ZipError('inflated size mismatch', 'corrupt');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
