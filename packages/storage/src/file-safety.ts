// Upload file-safety rules, applied after the MIME allowlist and the
// magic-byte check. Everything here is a pure inspection of the raw bytes and
// the client-supplied filename; nothing is stored or rewritten.
//
//   1. Filename: no executable or script extension in ANY dot segment
//      (invoice.pdf.exe), no control or bidi-override characters, and the final
//      extension (when it is a known one) must belong to the declared MIME type.
//   2. OLE2 compound files are refused whatever their claimed type: they cover
//      legacy doc/xls/ppt and password-protected Office files.
//   3. PDF: refused only when a password is needed to open it. An /Encrypt
//      dictionary that opens with an empty user password (an owner-only lock)
//      passes; any other handler or an unreadable dictionary is refused.
//   4. Office Open XML: the ZIP central directory is read and every entry is
//      inflated under hard caps (see ZIP_LIMITS). The package must carry
//      [Content_Types].xml and the main part for its claimed type, and may not
//      carry macros (vbaProject.bin or a macroEnabled content type), encrypted
//      entries, OLE objects, any embedded archive other than a docx, xlsx or
//      pptx (checked by the same rules one level deep only), or relationships
//      that load a template, OLE object, frame or sub-document from the
//      network, load anything but a hyperlink from a network share, or name
//      an ms-*/msdt protocol handler.

import { BLOCKED_MIME_TYPES, EXTENSIONS_BY_MIME, normalizeMime } from './mime';
import { isOle2Signature, isZipSignature } from './magic-bytes';

/** Why a file was refused. Each maps to one plain-language message. */
export type FileSafetyCode =
  | 'blocked_type'
  | 'mime_mismatch'
  | 'encrypted_file'
  | 'embedded_content'
  | 'archive_limits'
  | 'external_content';

export const FILE_SAFETY_MESSAGES: Readonly<Record<FileSafetyCode, string>> = {
  blocked_type: "This file type isn't allowed",
  mime_mismatch: "File contents don't match the file type",
  encrypted_file: "Password-protected files can't be shared",
  embedded_content: "This file contains embedded content that can't be checked.",
  archive_limits: 'This file is too complex to check',
  external_content: "This file loads content from the internet and can't be shared.",
};

export type FileSafetyResult = { ok: true } | { ok: false; code: FileSafetyCode; message: string };

/** Caps for any ZIP-based upload, counted across the package and its embeds. */
export const ZIP_LIMITS = {
  /** Total uncompressed bytes across every entry: 500 MiB. */
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  /** Entries across the package and any embedded package. */
  maxEntries: 10_000,
  /** Uncompressed : compressed, per entry and for the whole upload. */
  maxCompressionRatio: 1000,
  /** Embedded docx/xlsx/pptx are inspected; anything nested inside them is refused. */
  maxEmbedDepth: 1,
} as const;

/**
 * Extensions refused in any dot segment of a filename: executables, scripts,
 * installers, shortcuts, markup the browser runs, and macro-enabled Office.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // Windows executables, installers, shortcuts.
    'exe scr com pif cpl msi msp mst dll sys drv ocx bat cmd hta lnk reg scf inf url msc',
    'gadget chm application appref-ms appx msix appxbundle msixbundle',
    // Scripts.
    'js jse mjs cjs vbs vbe wsf wsh wsc ps1 psm1 psd1 ps1xml sh bash zsh csh ksh command',
    'py pyc pyw pl rb php asp aspx jsp cgi applescript scpt',
    // Other platforms' executables, packages and disk images.
    'jar app dmg pkg apk aab ipa xapk deb rpm bin elf dylib iso vhd vhdx',
    // Markup a browser executes.
    'html htm xhtml xht shtml mht mhtml svg svgz',
    // Macro-enabled and add-in Office.
    'docm dotm xlsm xltm xlam xla xll pptm potm ppsm ppam sldm',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Extensions recognized as naming a file type. A final extension outside this
 * set (e.g. "Report v2.1", "Meeting 10.30am") is treated as part of the name,
 * not as a type claim. Built from every allowed and blocked extension plus the
 * common types that would be a mismatch for any allowed MIME.
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.values(EXTENSIONS_BY_MIME).flat(),
  ...BLOCKED_EXTENSIONS,
  ...[
    'doc dot xls xlt xlsb ppt pot pps rtf odt ods odp txt csv tsv json xml md',
    'dotx xltx potx ppsx zip rar 7z gz tgz tar bz2 xz',
    'heic heif avif tif tiff bmp ico psd ai eps raw dng',
    'mkv avi wmv flv mpg mpeg 3gp wav flac ogg oga opus aac key pages numbers',
  ]
    .join(' ')
    .split(' '),
]);

/**
 * Inclusive code-point ranges refused in a filename: C0/C1 controls and the
 * bidi embedding/override/isolate controls that reorder text to disguise an
 * extension ("invoice<RLO>fdp.exe"). Joiners (ZWJ/ZWNJ, used by emoji and
 * Indic/Persian text) and plain direction marks stay allowed.
 */
const UNSAFE_NAME_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function hasUnsafeNameChar(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (UNSAFE_NAME_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

function refuse(code: FileSafetyCode): FileSafetyResult {
  return { ok: false, code, message: FILE_SAFETY_MESSAGES[code] };
}

const OK: FileSafetyResult = { ok: true };

/**
 * Basename of a client filename, NFKC-normalized, lowercased, and stripped of
 * invisible (default-ignorable) characters so "invoice.pdf.ex<ZWSP>e" is read as
 * ending in "exe". Only the checked copy is stripped; the name itself is kept.
 */
function normalizeName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  return base
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase();
}

/** Dot segments after the first, each trimmed of the spaces and dots Windows drops. */
function extensionSegments(name: string): string[] {
  return name
    .split('.')
    .slice(1)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/**
 * Filename rules: refuse unsafe characters and any blocked extension segment;
 * a known final extension must belong to the declared MIME type. A name with no
 * recognized extension is allowed (the signature check already matched).
 */
export function checkFilename(filename: string, mimeType: string): FileSafetyResult {
  if (hasUnsafeNameChar(filename)) {
    return refuse('blocked_type');
  }
  const segments = extensionSegments(normalizeName(filename));
  if (segments.some((segment) => BLOCKED_EXTENSIONS.has(segment))) {
    return refuse('blocked_type');
  }
  const last = segments.at(-1);
  if (last === undefined || !KNOWN_EXTENSIONS.has(last)) {
    return OK;
  }
  const mime = normalizeMime(mimeType);
  const allowed = (EXTENSIONS_BY_MIME as Readonly<Record<string, readonly string[]>>)[mime];
  if (allowed === undefined || !allowed.includes(last)) {
    return refuse('mime_mismatch');
  }
  return OK;
}

/** Index of `needle` in `haystack` at or after `from`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const utf16le = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) out[i * 2] = text.charCodeAt(i);
  return out;
};

const OLE_ENCRYPTED_PACKAGE = utf16le('EncryptedPackage');

// ---------------------------------------------------------------------------
// PDF encryption: refuse only when a password is needed to OPEN the file.
// ---------------------------------------------------------------------------

/** PDF whitespace and delimiters end a name token (ISO 32000 7.2.2). */
const PDF_NAME_TERMINATORS: ReadonlySet<number> = new Set([
  0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);
const PDF_WHITESPACE: ReadonlySet<number> = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** Longer than any spelling of /Encrypt or /ID, even with every byte #-escaped. */
const PDF_NAME_SCAN = 24;

function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/** Read a name token starting just after its '/', decoding #xx escapes. */
function readPdfName(bytes: Uint8Array, start: number, max: number): { name: string; end: number } {
  let name = '';
  let j = start;
  while (j < bytes.length && name.length <= max) {
    const byte = bytes[j] as number;
    if (PDF_NAME_TERMINATORS.has(byte)) break;
    if (byte === 0x23) {
      const hi = hexValue(bytes[j + 1]);
      const lo = hexValue(bytes[j + 2]);
      if (hi >= 0 && lo >= 0) {
        name += String.fromCharCode(hi * 16 + lo);
        j += 3;
        continue;
      }
    }
    name += String.fromCharCode(byte);
    j += 1;
  }
  return { name, end: j };
}

/** /ID arrays tried as the document identifier (the last ones in the file). */
const PDF_MAX_ID_CANDIDATES = 16;

/**
 * True when `/First` at `at` is followed by a number (an object stream header
 * length) rather than an "n g R" reference (an outline's /First). Lexes like a
 * reader: whitespace and comments between tokens, an optional sign or decimal
 * point. `cache` keeps comment skipping linear across the whole scan.
 */
function isNumericFirst(
  bytes: Uint8Array,
  at: number,
  cache: { from: number; to: number },
): boolean {
  let i = skipPdfSpace(bytes, at, cache);
  const number = (allowSign: boolean): number => {
    const start = i;
    if (allowSign && (bytes[i] === 0x2b || bytes[i] === 0x2d)) i += 1;
    while (isAsciiDigit(bytes[i]) || (allowSign && bytes[i] === 0x2e)) i += 1;
    return i - start;
  };
  const first = i;
  if (number(true) === 0) return false;
  // A sign or decimal point cannot start a reference; it is a number.
  const token = String.fromCharCode(...bytes.subarray(first, i));
  if (!/^\d+$/.test(token)) return /\d/.test(token);
  i = skipPdfSpace(bytes, i, cache);
  if (number(false) === 0) return true;
  i = skipPdfSpace(bytes, i, cache);
  const after = bytes[i + 1];
  return !(bytes[i] === 0x52 && (after === undefined || PDF_NAME_TERMINATORS.has(after)));
}

/**
 * Byte offsets just after every /Encrypt name and every /ID name, and the
 * positions of object streams.
 */
function scanPdfNames(bytes: Uint8Array): {
  encrypt: number[];
  ids: number[];
  objectStreams: number[];
} {
  const encrypt: number[] = [];
  const objectStreams: number[] = [];
  const ids: number[] = [];
  const commentCache = { from: 0, to: 0 };
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x2f) continue;
    const { name, end } = readPdfName(bytes, i + 1, PDF_NAME_SCAN);
    if (name === 'Encrypt') encrypt.push(end);
    else if (name === 'ID') ids.push(end);
    else if (name === 'ObjStm') objectStreams.push(i);
    // Readers take an object stream by its /First and /N, not its /Type, so a
    // dictionary with a numeric /First counts as one too.
    else if (name === 'First' && isNumericFirst(bytes, end, commentCache)) objectStreams.push(i);
  }
  return { encrypt, ids: ids.slice(-PDF_MAX_ID_CANDIDATES), objectStreams };
}

/**
 * True when the PDF carries an /Encrypt entry. Every name token is decoded,
 * including #xx escapes, so "/Encr#79pt" is caught; "/EncryptMetadata" is not
 * a match.
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  return scanPdfNames(bytes).encrypt.length > 0;
}

type PdfValue =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array }
  | { t: 'arr'; v: PdfValue[] }
  | { t: 'dict'; v: Map<string, PdfValue> }
  | { t: 'ref'; n: number; g: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

/** Nesting and size bounds so a hostile dictionary cannot cost much to read. */
const PDF_MAX_DEPTH = 16;
const PDF_MAX_OBJECT_BYTES = 64 * 1024;

/**
 * A minimal reader for one PDF object (ISO 32000 7.3): enough to read an
 * encryption dictionary and a trailer /ID. Returns null on anything malformed.
 */
class PdfObjectReader {
  private pos: number;
  private readonly limit: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    maxBytes = PDF_MAX_OBJECT_BYTES,
  ) {
    this.pos = start;
    this.limit = Math.min(bytes.length, start + maxBytes);
  }

  /** Byte offset just after the last value read. */
  get offset(): number {
    return this.pos;
  }

  private peek(offset = 0): number | undefined {
    const at = this.pos + offset;
    return at < this.limit ? this.bytes[at] : undefined;
  }

  private skipSpace(): void {
    for (;;) {
      const byte = this.peek();
      if (byte === undefined) return;
      if (PDF_WHITESPACE.has(byte)) {
        this.pos += 1;
      } else if (byte === 0x25) {
        while (this.peek() !== undefined && this.peek() !== 0x0a && this.peek() !== 0x0d) {
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  private isDigit(byte: number | undefined): boolean {
    return byte !== undefined && byte >= 0x30 && byte <= 0x39;
  }

  private readInteger(): number | null {
    let text = '';
    while (this.isDigit(this.peek()) && text.length < 12) {
      text += String.fromCharCode(this.peek() as number);
      this.pos += 1;
    }
    return text === '' ? null : Number(text);
  }

  private readNumber(): PdfValue | null {
    let text = '';
    for (;;) {
      const byte = this.peek();
      if (
        byte === undefined ||
        !(this.isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e)
      ) {
        break;
      }
      text += String.fromCharCode(byte);
      this.pos += 1;
      if (text.length > 32) return null;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    // "n g R" is an indirect reference.
    if (/^\d+$/.test(text)) {
      const save = this.pos;
      this.skipSpace();
      const generation = this.readInteger();
      if (generation !== null) {
        this.skipSpace();
        const after = this.peek(1);
        if (this.peek() === 0x52 && (after === undefined || PDF_NAME_TERMINATORS.has(after))) {
          this.pos += 1;
          return { t: 'ref', n: value, g: generation };
        }
      }
      this.pos = save;
    }
    return { t: 'num', v: value };
  }

  private readLiteralString(): PdfValue | null {
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    for (;;) {
      const byte = this.peek();
      if (byte === undefined) return null;
      this.pos += 1;
      if (byte === 0x5c) {
        const next = this.peek();
        if (next === undefined) return null;
        this.pos += 1;
        const simple: Record<number, number> = {
          0x6e: 0x0a,
          0x72: 0x0d,
          0x74: 0x09,
          0x62: 0x08,
          0x66: 0x0c,
          0x28: 0x28,
          0x29: 0x29,
          0x5c: 0x5c,
        };
        const mapped = simple[next];
        if (mapped !== undefined) {
          out.push(mapped);
        } else if (next >= 0x30 && next <= 0x37) {
          let code = next - 0x30;
          for (
            let k = 0;
            k < 2 && (this.peek() ?? 0) >= 0x30 && (this.peek() ?? 0) <= 0x37;
            k += 1
          ) {
            code = code * 8 + ((this.peek() as number) - 0x30);
            this.pos += 1;
          }
          out.push(code & 0xff);
        } else if (next === 0x0d) {
          if (this.peek() === 0x0a) this.pos += 1;
        } else if (next !== 0x0a) {
          out.push(next);
        }
      } else if (byte === 0x0d) {
        // An unescaped end-of-line is read as a single LF.
        if (this.peek() === 0x0a) this.pos += 1;
        out.push(0x0a);
      } else {
        if (byte === 0x28) depth += 1;
        if (byte === 0x29) {
          depth -= 1;
          if (depth === 0) return { t: 'str', v: Uint8Array.from(out) };
        }
        out.push(byte);
      }
    }
  }

  private readHexString(): PdfValue | null {
    this.pos += 1;
    const digits: number[] = [];
    for (;;) {
      const byte = this.peek();
      if (byte === undefined) return null;
      this.pos += 1;
      if (byte === 0x3e) break;
      if (PDF_WHITESPACE.has(byte)) continue;
      const value = hexValue(byte);
      if (value < 0) return null;
      digits.push(value);
    }
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = (digits[i * 2] as number) * 16 + (digits[i * 2 + 1] as number);
    }
    return { t: 'str', v: out };
  }

  read(depth = 0): PdfValue | null {
    if (depth > PDF_MAX_DEPTH) return null;
    this.skipSpace();
    const byte = this.peek();
    if (byte === undefined) return null;
    if (byte === 0x3c && this.peek(1) === 0x3c) {
      this.pos += 2;
      const dict = new Map<string, PdfValue>();
      for (;;) {
        this.skipSpace();
        if (this.peek() === 0x3e && this.peek(1) === 0x3e) {
          this.pos += 2;
          return { t: 'dict', v: dict };
        }
        if (this.peek() !== 0x2f) return null;
        const { name, end } = readPdfName(this.bytes, this.pos + 1, 127);
        this.pos = end;
        const value = this.read(depth + 1);
        if (value === null) return null;
        dict.set(name, value);
      }
    }
    if (byte === 0x3c) return this.readHexString();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x5b) {
      this.pos += 1;
      const items: PdfValue[] = [];
      for (;;) {
        this.skipSpace();
        if (this.peek() === 0x5d) {
          this.pos += 1;
          return { t: 'arr', v: items };
        }
        const value = this.read(depth + 1);
        if (value === null) return null;
        items.push(value);
      }
    }
    if (byte === 0x2f) {
      const { name, end } = readPdfName(this.bytes, this.pos + 1, 127);
      this.pos = end;
      return { t: 'name', v: name };
    }
    if (this.isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.readNumber();
    }
    for (const [word, value] of [
      ['true', { t: 'bool', v: true }],
      ['false', { t: 'bool', v: false }],
      ['null', { t: 'null' }],
    ] as const) {
      if ([...word].every((char, i) => this.peek(i) === char.charCodeAt(0))) {
        this.pos += word.length;
        return value;
      }
    }
    return null;
  }
}

const PDF_OBJ = new TextEncoder().encode('obj');
const PDF_MAX_LEADING_ZEROS = 16;
/** An object stream's dictionary sits just before its /Type or /First key. */
const PDF_OBJECT_STREAM_DICT_WINDOW = 4096;
/** "obj" anchors tried as object-stream starts, per file. */
const PDF_MAX_OBJECT_STREAM_ANCHORS = 20_000;
const PDF_STREAM = new TextEncoder().encode('stream');
/** More distinct encryption dictionaries than this is refused, not computed. */
const PDF_MAX_ENCRYPT_DICTS = 4;
/** Object streams inspected for a hidden encryption dictionary. */
const PDF_MAX_OBJECT_STREAMS = 4096;
const PDF_MAX_OBJECT_STREAM_HEADER = 1024 * 1024;
/** Total object-stream header bytes inflated per file. */
const PDF_MAX_OBJECT_STREAM_HEADERS_TOTAL = 8 * 1024 * 1024;

function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/**
 * Skip PDF whitespace and comments forward from `at`; returns the new offset.
 * `cache` remembers the end of the last comment line scanned, so repeated
 * probes inside one long comment stay linear overall.
 */
function skipPdfSpace(bytes: Uint8Array, at: number, cache: { from: number; to: number }): number {
  let i = at;
  for (;;) {
    const byte = bytes[i];
    if (byte === undefined) return i;
    if (PDF_WHITESPACE.has(byte)) {
      i += 1;
    } else if (byte === 0x25) {
      if (i >= cache.from && i < cache.to) {
        i = cache.to;
        continue;
      }
      const start = i;
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
      cache.from = start;
      cache.to = i;
    } else {
      return i;
    }
  }
}

/**
 * Every plain-text definition "n g obj" of the wanted objects, read forward
 * the way a reader's lexer does (any whitespace or comments between the parts,
 * any byte before the number), as offsets just after "obj". Readers resolve
 * objects through the xref, so a reference is trusted only when exactly one
 * definition exists; a second (decoy) definition anywhere makes it unknown.
 */
function findObjectDefinitions(
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const key of wanted) {
    const [n, g] = key.split(' ').map(Number) as [number, number];
    const needle = new TextEncoder().encode(String(n));
    const offsets: number[] = [];
    const cache = { from: 0, to: 0 };
    for (
      let at = indexOfBytes(bytes, needle);
      at !== -1;
      at = indexOfBytes(bytes, needle, at + 1)
    ) {
      // Leading zeros are the same number; any other digit before is not.
      // A long zero run counts as leading zeros (a possible definition), so
      // the walk-back stays bounded without hiding one.
      let start = at;
      while (start > 0 && at - start < PDF_MAX_LEADING_ZEROS && bytes[start - 1] === 0x30) {
        start -= 1;
      }
      if (bytes[start - 1] !== 0x30 && isAsciiDigit(bytes[start - 1])) continue;
      let i = at + needle.length;
      if (isAsciiDigit(bytes[i])) continue;
      const afterNumber = skipPdfSpace(bytes, i, cache);
      if (afterNumber === i) continue;
      i = afterNumber;
      let generation = '';
      while (isAsciiDigit(bytes[i]) && generation.length < 10) {
        generation += String.fromCharCode(bytes[i] as number);
        i += 1;
      }
      if (generation === '' || Number(generation) !== g || isAsciiDigit(bytes[i])) continue;
      const afterGeneration = skipPdfSpace(bytes, i, cache);
      if (afterGeneration === i) continue;
      i = afterGeneration;
      if (indexOfBytes(bytes.subarray(i, i + 3), PDF_OBJ) !== 0) continue;
      const after = bytes[i + 3];
      if (after !== undefined && !PDF_NAME_TERMINATORS.has(after)) continue;
      offsets.push(i + 3);
    }
    found.set(key, offsets);
  }
  return found;
}

/** Offset of the last `needle` that starts before `from`, or -1. */
function lastIndexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
  floor: number,
): number {
  outer: for (let i = Math.min(from, haystack.length - needle.length); i >= floor; i -= 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** RFC 1950 header check: deflate method, valid check bits, no preset dictionary. */
function isZlibHeader(cmf: number | undefined, flg: number | undefined): boolean {
  if (cmf === undefined || flg === undefined) return false;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

/** Compressed bytes fed to object-stream header inflation, per file. */
const PDF_MAX_OBJECT_STREAM_INPUT_TOTAL = 64 * 1024 * 1024;
/** Inflate input chunks start small and grow, so a stream that fails fast costs little. */
const PDF_INFLATE_FIRST_CHUNK = 512;
const PDF_INFLATE_MAX_CHUNK = 64 * 1024;

/**
 * The first `limit` bytes a zlib (FlateDecode) stream inflates to: 'short' when
 * the data ends or fails first, 'budget' when the per-file input budget runs
 * out. The data is fed in chunks and feeding stops as soon as the header is
 * out, so padding (e.g. empty stored blocks) costs only the bytes it occupies.
 */
async function inflateZlibHead(
  data: Uint8Array,
  limit: number,
  budget: { inputBytes: number },
): Promise<Uint8Array | 'short' | 'budget'> {
  const view =
    data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice();
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  let outOfBudget = false;
  const pump = (async () => {
    for (let at = 0, size = PDF_INFLATE_FIRST_CHUNK; at < view.length; at += size) {
      size = Math.min(size * 2, PDF_INFLATE_MAX_CHUNK);
      const chunk = view.subarray(at, at + size);
      budget.inputBytes += chunk.length;
      if (budget.inputBytes > PDF_MAX_OBJECT_STREAM_INPUT_TOTAL) {
        outOfBudget = true;
        return;
      }
      await writer.write(chunk);
    }
    await writer.close();
  })().catch(() => undefined);
  const reader = stream.readable.getReader();
  const out = new Uint8Array(limit);
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      const take = Math.min(next.value.byteLength, limit - total);
      out.set(next.value.subarray(0, take), total);
      total += take;
    }
  } catch {
    // A corrupt tail after the header is fine; the header is not.
  }
  await reader.cancel().catch(() => undefined);
  await writer.abort().catch(() => undefined);
  await pump;
  if (total >= limit) return out;
  return outOfBudget ? 'budget' : 'short';
}

type ObjectStreamCheck =
  | { kind: 'not_object_stream' }
  | { kind: 'unchecked' | 'encrypted'; dictEnd: number }
  | { kind: 'members'; members: number[]; dictEnd: number };

/**
 * What the object starting at the "obj" at `objAt` holds, when its dictionary
 * is an object stream's (/Type /ObjStm or a numeric /First):
 * - 'encrypted': FlateDecode data that does not inflate. In an encrypted PDF
 *   object streams are encrypted with the document key, so a reader cannot
 *   take the encryption dictionary itself from one; nothing to check.
 * - 'unchecked': anything else unreadable (another filter, DecodeParms, a
 *   malformed dictionary, an oversized header). Treated as unknown.
 * - the object numbers it stores, when it is readable plaintext.
 */
async function objectStreamMembers(
  bytes: Uint8Array,
  objAt: number,
  budget: { headerBytes: number; inputBytes: number },
): Promise<ObjectStreamCheck> {
  const reader = new PdfObjectReader(bytes, objAt + 3, PDF_OBJECT_STREAM_DICT_WINDOW);
  const dict = reader.read();
  if (dict?.t !== 'dict') return { kind: 'not_object_stream' };
  const dictEnd = reader.offset;
  const type = dict.v.get('Type');
  const firstValue = dict.v.get('First');
  if (firstValue?.t !== 'num' && !(type?.t === 'name' && type.v === 'ObjStm')) {
    return { kind: 'not_object_stream' };
  }
  const unchecked: ObjectStreamCheck = { kind: 'unchecked', dictEnd };
  const filter = dict.v.get('Filter');
  const flate =
    filter === undefined ||
    (filter.t === 'name' && filter.v === 'FlateDecode') ||
    (filter.t === 'arr' &&
      filter.v.length === 1 &&
      filter.v[0]?.t === 'name' &&
      filter.v[0].v === 'FlateDecode');
  const first = dict.v.get('First');
  const count = dict.v.get('N');
  if (!flate || dict.v.has('DecodeParms') || first?.t !== 'num' || count?.t !== 'num')
    return unchecked;
  if (first.v <= 0 || first.v > PDF_MAX_OBJECT_STREAM_HEADER) return unchecked;
  budget.headerBytes += first.v;
  if (budget.headerBytes > PDF_MAX_OBJECT_STREAM_HEADERS_TOTAL) return unchecked;
  let start = reader.offset;
  while (start < bytes.length && PDF_WHITESPACE.has(bytes[start] as number)) start += 1;
  if (indexOfBytes(bytes.subarray(start, start + PDF_STREAM.length), PDF_STREAM) !== 0)
    return unchecked;
  start += PDF_STREAM.length;
  if (bytes[start] === 0x0d) start += 1;
  if (bytes[start] === 0x0a) start += 1;
  // Only the header is needed; inflation stops once it is out (no copy of the
  // stream, no search for endstream), within a per-file input budget.
  const length = dict.v.get('Length');
  const available = bytes.length - start;
  const declared = length?.t === 'num' && length.v >= 0 ? Math.min(length.v, available) : available;
  let raw: Uint8Array;
  if (filter === undefined) {
    if (declared < first.v) return unchecked;
    raw = bytes.subarray(start, start + first.v);
  } else {
    const head = await inflateZlibHead(bytes.subarray(start, start + declared), first.v, budget);
    if (head === 'budget') return unchecked;
    // Encrypted object streams do not even start with a valid zlib header.
    // A valid header that does not inflate to the full header is unknown.
    if (head === 'short') {
      return isZlibHeader(bytes[start], bytes[start + 1])
        ? unchecked
        : { kind: 'encrypted', dictEnd };
    }
    raw = head;
  }
  const numbers = new TextDecoder('latin1').decode(raw).trim().split(/\s+/).map(Number);
  if (numbers.length < count.v * 2 || numbers.some((value) => !Number.isInteger(value)))
    return unchecked;
  return {
    kind: 'members',
    members: numbers.filter((_, i) => i % 2 === 0).slice(0, count.v),
    dictEnd,
  };
}

// MD5 (RFC 1321) and RC4: the PDF standard security handler for revisions 2-4
// needs both, and Web Crypto offers neither.
const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

function md5(input: Uint8Array): Uint8Array {
  const length = input.length;
  const padded = new Uint8Array(((length + 8) >>> 6) * 64 + 64);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor((length * 8) / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let block = 0; block < padded.length; block += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const shift = MD5_SHIFTS[(i >>> 4) * 4 + (i % 4)] as number;
      const sum = (a + f + (MD5_K[i] as number) + view.getUint32(block + g * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true));
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + (s[i] as number)) & 0xff;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
    out[k] = (data[k] as number) ^ (s[((s[i] as number) + (s[j] as number)) & 0xff] as number);
  }
  return out;
}

/** The 32-byte padding string of the standard security handler (Algorithm 2). */
const PDF_PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.length >= prefix.length && prefix.every((byte, i) => value[i] === byte);
}

/** Revisions 2-4: Algorithm 2 key from the empty password, then Algorithm 4/5. */
function emptyPasswordOpensRc4(
  revision: number,
  o: Uint8Array,
  u: Uint8Array,
  permissions: number,
  id0: Uint8Array,
): boolean {
  if (o.length < 32 || u.length < 16) return false;
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, permissions >>> 0, true);
  // The key length (Length) is read inconsistently by writers; trying every
  // legal length costs nothing and a wrong length cannot match a 16-byte check.
  const lengths = revision === 2 ? [5] : Array.from({ length: 12 }, (_, i) => i + 5);
  const metadataFlags = revision >= 4 ? [false, true] : [false];
  for (const skipMetadata of metadataFlags) {
    const seed = md5(
      concatBytes(
        PDF_PASSWORD_PAD,
        o.subarray(0, 32),
        p,
        id0,
        skipMetadata ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0),
      ),
    );
    for (const n of lengths) {
      let hash = seed;
      if (revision >= 3) {
        for (let i = 0; i < 50; i += 1) hash = md5(hash.subarray(0, n));
      }
      const key = hash.subarray(0, n);
      if (revision === 2) {
        if (u.length >= 32 && startsWithBytes(rc4(key, PDF_PASSWORD_PAD), u.subarray(0, 32))) {
          return true;
        }
        continue;
      }
      let x = rc4(key, md5(concatBytes(PDF_PASSWORD_PAD, id0)));
      for (let i = 1; i <= 19; i += 1)
        x = rc4(
          key.map((byte) => byte ^ i),
          x,
        );
      if (startsWithBytes(x, u.subarray(0, 16))) return true;
    }
  }
  return false;
}

async function digest(algorithm: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data.slice()));
}

/** Revision 6 hash (ISO 32000-2 Algorithm 2.B) for the empty user password. */
async function revision6Hash(salt: Uint8Array): Promise<Uint8Array> {
  let k = await digest('SHA-256', salt);
  let e = new Uint8Array(0);
  for (let round = 0; round < 64 || (e.at(-1) ?? 0) > round - 32; round += 1) {
    const k1 = new Uint8Array(k.length * 64);
    for (let i = 0; i < 64; i += 1) k1.set(k, i * k.length);
    const key = await crypto.subtle.importKey('raw', k.slice(0, 16), 'AES-CBC', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: k.slice(16, 32) },
      key,
      k1,
    );
    // Web Crypto appends one PKCS#7 block; K1 is block-aligned, so drop it.
    e = new Uint8Array(encrypted, 0, k1.length);
    const selector = e.subarray(0, 16).reduce((sum, byte) => sum + byte, 0) % 3;
    k = await digest(selector === 0 ? 'SHA-256' : selector === 1 ? 'SHA-384' : 'SHA-512', e);
    if (round > 4096) break;
  }
  return k.subarray(0, 32);
}

/**
 * True when the encryption dictionary opens with an empty user password (an
 * owner-only lock). Anything but the standard handler at revisions 2-6 is
 * treated as needing a password.
 */
async function emptyUserPasswordOpens(
  dict: Map<string, PdfValue>,
  idCandidates: readonly Uint8Array[],
): Promise<boolean> {
  const filter = dict.get('Filter');
  if (filter?.t !== 'name' || filter.v !== 'Standard') return false;
  const revision = dict.get('R');
  const o = dict.get('O');
  const u = dict.get('U');
  const p = dict.get('P');
  if (revision?.t !== 'num' || o?.t !== 'str' || u?.t !== 'str') return false;
  if (revision.v >= 2 && revision.v <= 4) {
    const permissions = p?.t === 'num' ? p.v : null;
    return (
      permissions !== null &&
      idCandidates.some((id0) => emptyPasswordOpensRc4(revision.v, o.v, u.v, permissions, id0))
    );
  }
  if ((revision.v === 5 || revision.v === 6) && u.v.length >= 40) {
    const salt = u.v.subarray(32, 40);
    const hash = revision.v === 5 ? await digest('SHA-256', salt) : await revision6Hash(salt);
    return startsWithBytes(hash, u.v.subarray(0, 32));
  }
  return false;
}

/**
 * Candidate document identifiers: the first string of each /ID array (other
 * objects such as tagged-PDF structure elements also carry /ID, so the trailer's
 * cannot be told apart by position), plus the empty identifier.
 */
function pdfIdCandidates(bytes: Uint8Array, ids: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [new Uint8Array(0)];
  for (const at of ids) {
    const value = new PdfObjectReader(bytes, at, PDF_OBJECT_STREAM_DICT_WINDOW).read();
    const first = value?.t === 'arr' ? value.v[0] : undefined;
    if (first?.t === 'str') out.push(first.v);
  }
  return out;
}

/**
 * True when a password is needed to OPEN the PDF. An /Encrypt dictionary that
 * opens with an empty user password (no-edit/no-print/no-copy locks) passes;
 * an unreadable dictionary, another handler (e.g. /Adobe.PubSec) or an
 * unsupported revision counts as password-protected.
 */
export async function pdfNeedsPassword(bytes: Uint8Array): Promise<boolean> {
  const { encrypt, ids, objectStreams } = scanPdfNames(bytes);
  if (encrypt.length === 0) return false;

  // Each distinct dictionary is checked once; a pile of them is refused
  // rather than computed (each check costs key derivation or the R6 hash).
  const inline: Array<Map<string, PdfValue>> = [];
  const refs = new Set<string>();
  for (const at of encrypt) {
    const value = new PdfObjectReader(bytes, at).read();
    if (value?.t === 'ref') refs.add(`${value.n} ${value.g}`);
    else if (value?.t === 'dict') inline.push(value.v);
    else return true;
    if (refs.size + inline.length > PDF_MAX_ENCRYPT_DICTS) return true;
  }

  const dicts = [...inline];
  if (refs.size > 0) {
    // Object 0 is the free-list head; it can never hold a dictionary.
    if ([...refs].some((key) => key.startsWith('0 '))) return true;
    const definitions = findObjectDefinitions(bytes, refs);
    for (const key of refs) {
      const offsets = definitions.get(key) ?? [];
      if (offsets.length !== 1) return true;
      const value = new PdfObjectReader(bytes, offsets[0] as number).read();
      if (value?.t !== 'dict') return true;
      dicts.push(value.v);
    }
    // A reader could also find the object inside an object stream (where no
    // text definition is visible), so every object stream must be readable and
    // must not contain a referenced encryption dictionary.
    if (objectStreams.length > PDF_MAX_OBJECT_STREAMS) return true;
    const numbers = new Set([...refs].map((key) => Number(key.split(' ')[0])));
    const budget = { headerBytes: 0, inputBytes: 0 };
    // The object's own "obj" is not always the nearest one before /Type or
    // /First (a string in the dictionary can hold a decoy "obj << ... >>
    // stream"), so every "obj" in the window is tried, and each /ObjStm or
    // numeric /First must sit inside a dictionary that was checked as an
    // object stream. Attempts are capped per file.
    const checks = new Map<number, ObjectStreamCheck>();
    for (const at of objectStreams) {
      const floor = Math.max(0, at - PDF_OBJECT_STREAM_DICT_WINDOW);
      let covered = false;
      for (let objAt = lastIndexOfBytes(bytes, PDF_OBJ, at, floor); objAt !== -1; ) {
        let check = checks.get(objAt);
        if (check === undefined) {
          if (checks.size >= PDF_MAX_OBJECT_STREAM_ANCHORS) return true;
          check = await objectStreamMembers(bytes, objAt, budget);
          checks.set(objAt, check);
        }
        if (check.kind === 'unchecked') return true;
        if (check.kind === 'members' && check.members.some((n) => numbers.has(n))) return true;
        if (check.kind !== 'not_object_stream' && at < check.dictEnd) covered = true;
        objAt = objAt > floor ? lastIndexOfBytes(bytes, PDF_OBJ, objAt - 1, floor) : -1;
      }
      if (!covered) return true;
    }
  }

  const idCandidates = pdfIdCandidates(bytes, ids);
  for (const dict of dicts) {
    if (!(await emptyUserPasswordOpens(dict, idCandidates))) return true;
  }
  return false;
}

/** OLE2 files are refused; a password-protected Office file gets its own copy. */
function checkOle2(bytes: Uint8Array): FileSafetyResult {
  return indexOfBytes(bytes, OLE_ENCRYPTED_PACKAGE) !== -1
    ? refuse('encrypted_file')
    : refuse('blocked_type');
}

// ---------------------------------------------------------------------------
// ZIP reading (central directory first, then each entry inflated under caps).
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

interface ZipEntry {
  name: string;
  /** Raw name bytes from the central directory, compared to the local header. */
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

type ZipRead =
  | { ok: true; entries: ZipEntry[]; cdOffset: number }
  | { ok: false; code: FileSafetyCode };

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

/** Parse the central directory. Any structural oddity reads as a mismatch. */
function readCentralDirectory(bytes: Uint8Array): ZipRead {
  const bad: ZipRead = { ok: false, code: 'mime_mismatch' };
  if (bytes.length < EOCD_MIN) return bad;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const stop = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let i = bytes.length - EOCD_MIN; i >= stop; i -= 1) {
    if (u32(view, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return bad;
  // ZIP64 and split archives are never needed under the 100 MiB upload cap.
  if (eocd >= 20 && u32(view, eocd - 20) === SIG_ZIP64_LOCATOR) return bad;
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) return bad;

  const count = u16(view, eocd + 10);
  if (count !== u16(view, eocd + 8)) return bad;
  const cdSize = u32(view, eocd + 12);
  const cdOffset = u32(view, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return bad;
  if (cdOffset + cdSize > eocd) return bad;
  if (count > ZIP_LIMITS.maxEntries) return { ok: false, code: 'archive_limits' };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > cdOffset + cdSize || u32(view, at) !== SIG_CENTRAL) return bad;
    const nameLen = u16(view, at + 28);
    const extraLen = u16(view, at + 30);
    const commentLen = u16(view, at + 32);
    const entry: ZipEntry = {
      flags: u16(view, at + 8),
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      uncompressedSize: u32(view, at + 24),
      localOffset: u32(view, at + 42),
      // Some writers use backslash separators; read them as '/' so every
      // path rule (embeddings/, main part, duplicates) sees one spelling.
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/'),
      nameBytes: bytes.subarray(at + 46, at + 46 + nameLen),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.uncompressedSize === 0xffffffff ||
      entry.localOffset === 0xffffffff
    ) {
      return bad;
    }
    entries.push(entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries, cdOffset };
}

/** Shared budget for the outer package and everything embedded in it. */
interface ZipBudget {
  entries: number;
  uncompressedBytes: number;
  /** Byte length of the uploaded file, for the whole-upload ratio cap. */
  uploadBytes: number;
}

type Inflated =
  | { ok: true; head: Uint8Array; body: Uint8Array | null }
  | { ok: false; code: FileSafetyCode };

const HEAD_BYTES = 8;

/**
 * Inflate one entry's data, counting output as it streams. More output than
 * the central directory declared (a lying header) is refused as over the caps.
 * Only the first bytes are kept unless `keep` is set.
 */
async function inflateEntry(entry: ZipEntry, data: Uint8Array, keep: boolean): Promise<Inflated> {
  if (entry.method === METHOD_STORED) {
    if (data.length !== entry.uncompressedSize) return { ok: false, code: 'mime_mismatch' };
    return { ok: true, head: data.subarray(0, HEAD_BYTES), body: keep ? data : null };
  }

  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = writer
    .write(data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice())
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  // The declared size is already capped, so the kept buffer is sized once.
  const body = keep ? new Uint8Array(entry.uncompressedSize) : null;
  const head = new Uint8Array(HEAD_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total < HEAD_BYTES) {
        head.set(value.subarray(0, HEAD_BYTES - total), total);
      }
      total += value.byteLength;
      if (total > entry.uncompressedSize) {
        await reader.cancel().catch(() => undefined);
        await written;
        return { ok: false, code: 'archive_limits' };
      }
      if (body !== null) body.set(value, total - value.byteLength);
    }
  } catch {
    await written;
    return { ok: false, code: 'mime_mismatch' };
  }
  await written;
  if (total !== entry.uncompressedSize) return { ok: false, code: 'mime_mismatch' };

  return { ok: true, head: head.subarray(0, Math.min(total, HEAD_BYTES)), body };
}

// ---------------------------------------------------------------------------
// Office Open XML rules.
// ---------------------------------------------------------------------------

type OoxmlKind = 'docx' | 'xlsx' | 'pptx';

const OOXML_BY_MIME: Readonly<Record<string, OoxmlKind>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const MAIN_PART: Readonly<Record<OoxmlKind, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

/** The main-part content type each kind must declare in [Content_Types].xml. */
const MAIN_CONTENT_TYPE: Readonly<Record<OoxmlKind, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};

const CONTENT_TYPES_PART = '[content_types].xml';

/**
 * Plain data blobs Office stores as .bin: printer setup (DEVMODE) and Excel
 * worksheet custom properties. Not OLE objects; still checked for nested
 * containers like every other part.
 */
const DATA_BLOB_BIN = /^(printersettings|customproperty)\d*\.bin$/;

/**
 * Largest part inflated into memory for inspection: an embedded docx/xlsx/pptx
 * or [Content_Types].xml. Keeps a Worker well inside its memory limit; a chart
 * workbook is typically kilobytes.
 */
export const MAX_INSPECTED_PART_BYTES = 16 * 1024 * 1024;

/**
 * Leading bytes of containers and executables that may not hide inside an
 * Office package under any name (zip variants, OLE2, rar, 7z, gzip, bzip2,
 * xz, cab, PE/DOS executables, ELF).
 */
const NESTED_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x4d, 0x53, 0x43, 0x46],
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
];

/**
 * Parts whose leading bytes are legitimately compressed or obfuscated:
 * gzip-wrapped metafiles (.emz, .wmz) and embedded fonts (.odttf, .fntdata).
 * They are still counted, capped and checked for ZIP/OLE2/RAR/7z content.
 */
const COMPRESSED_MEDIA = /\.(emz|wmz)$/;
const OBFUSCATED_FONT = /\.(odttf|fntdata)$/;
const STRONG_SIGNATURE_MIN = 4;

function isNestedContainer(head: Uint8Array, name: string): boolean {
  const gzipOk = COMPRESSED_MEDIA.test(name);
  const shortOk = OBFUSCATED_FONT.test(name);
  return NESTED_SIGNATURES.some(
    (sig) =>
      !(shortOk && sig.length < STRONG_SIGNATURE_MIN) &&
      !(gzipOk && sig[0] === 0x1f && sig[1] === 0x8b) &&
      head.length >= sig.length &&
      sig.every((byte, i) => head[i] === byte),
  );
}

function ooxmlKindForMime(mimeType: string): OoxmlKind | null {
  return OOXML_BY_MIME[normalizeMime(mimeType)] ?? null;
}

function ooxmlKindForName(name: string): OoxmlKind | null {
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.pptx')) return 'pptx';
  return null;
}

function basename(name: string): string {
  return name.split('/').pop() ?? name;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Decode XML character and predefined entity references ("&#109;" -> "m"). */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10);
      // An out-of-range reference decodes to U+FFFD instead of throwing (a 500).
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? '';
  });
}

interface XmlTag {
  /** Element local name (prefix dropped), lowercased. */
  name: string;
  /** Attributes by lowercased name, values entity-decoded. */
  attrs: Map<string, string>;
}

/**
 * Every start tag of an XML document with its attributes, read in order and
 * honouring quotes, so a '>' or a lookalike "TargetMode=..." inside another
 * attribute's value can neither end a tag early nor spoof an attribute.
 * Returns null for anything malformed (unterminated quotes, '<' in a value,
 * duplicate attributes, a DTD), which callers refuse.
 */
function xmlStartTags(text: string): XmlTag[] | null {
  const tags: XmlTag[] = [];
  const isSpace = (char: string | undefined): boolean =>
    char === ' ' || char === '\t' || char === '\n' || char === '\r';
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt === -1) return tags;
    const skipTo = (open: string, close: string): number | null => {
      if (!text.startsWith(open, lt)) return null;
      const end = text.indexOf(close, lt + open.length);
      return end === -1 ? -1 : end + close.length;
    };
    const skipped = skipTo('<!--', '-->') ?? skipTo('<![CDATA[', ']]>') ?? skipTo('<?', '?>');
    if (skipped !== null) {
      if (skipped === -1) return null;
      i = skipped;
      continue;
    }
    if (text[lt + 1] === '!') return null;
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    while (j < text.length && !isSpace(text[j]) && text[j] !== '/' && text[j] !== '>') j += 1;
    const qualified = text.slice(lt + 1, j);
    if (qualified === '') return null;
    const attrs = new Map<string, string>();
    for (;;) {
      while (isSpace(text[j])) j += 1;
      const char = text[j];
      if (char === undefined) return null;
      if (char === '>') {
        j += 1;
        break;
      }
      if (char === '/' && text[j + 1] === '>') {
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < text.length && !isSpace(text[j]) && !'=/>'.includes(text[j] as string)) j += 1;
      const attrName = text.slice(nameStart, j).toLowerCase();
      if (attrName === '') return null;
      while (isSpace(text[j])) j += 1;
      if (text[j] !== '=') return null;
      j += 1;
      while (isSpace(text[j])) j += 1;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return null;
      const end = text.indexOf(quote, j + 1);
      if (end === -1) return null;
      const raw = text.slice(j + 1, end);
      if (raw.includes('<') || attrs.has(attrName)) return null;
      attrs.set(attrName, decodeXmlEntities(raw));
      j = end + 1;
    }
    tags.push({ name: (qualified.split(':').pop() ?? '').toLowerCase(), attrs });
    i = j;
  }
}

/**
 * A package XML part ([Content_Types].xml or a .rels part) as text, or null
 * when it cannot be read the way the checks read it: anything but strict UTF-8 (a UTF-16 BOM, NUL bytes, invalid
 * sequences, another declared encoding) or a DTD, whose entities could spell a
 * macro type the text search would not see. Office writes UTF-8 without a DTD.
 */
function decodeStrictXml(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const declared = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']*)["']/i.exec(text)?.[1];
  if (declared !== undefined && !/^utf-?8$/i.test(declared)) return null;
  if (/<!doctype|<!entity/i.test(text)) return null;
  return text;
}

/**
 * [Content_Types].xml rules: no macro or VBA content type anywhere (checked on
 * the entity-decoded text), and the main part must be declared with exactly the
 * claimed type's main content type.
 */
function checkContentTypes(raw: string, kind: OoxmlKind): FileSafetyResult {
  const decoded = decodeXmlEntities(raw).toLowerCase();
  // macrosheet also covers intlmacrosheet (Excel 4.0 XLM macro sheets).
  if (['macroenabled', 'vbaproject', 'macrosheet'].some((token) => decoded.includes(token))) {
    return refuse('blocked_type');
  }
  // OPC: a part's type is its Override, else the Default for its extension
  // (the .NET packaging writers declare the main part through Default). Tags
  // may carry a namespace prefix (<ns0:Override>).
  const tags = xmlStartTags(raw);
  if (tags === null) return refuse('mime_mismatch');
  const mainPart = `/${MAIN_PART[kind]}`;
  let mainType: string | null = null;
  for (const tag of tags) {
    if (tag.name !== 'override') continue;
    const part = tag.attrs.get('partname');
    if (part !== undefined && part.replace(/\\/g, '/').toLowerCase() === mainPart) {
      mainType = tag.attrs.get('contenttype') ?? '';
      break;
    }
  }
  if (mainType === null) {
    const extension = mainPart.split('.').pop() ?? '';
    for (const tag of tags) {
      if (
        tag.name === 'default' &&
        (tag.attrs.get('extension') ?? '').toLowerCase() === extension
      ) {
        mainType = tag.attrs.get('contenttype') ?? '';
        break;
      }
    }
  }
  return mainType !== null && mainType.trim().toLowerCase() === MAIN_CONTENT_TYPE[kind]
    ? OK
    : refuse('mime_mismatch');
}

/**
 * Relationship types that make Office fetch and load something from the
 * Target when it is external: a remote template (macros), a linked OLE object
 * (the Follina route), a remote frame, or a remote sub-document. Matched on the
 * last path segment so transitional and strict namespaces both count.
 */
const REMOTE_LOADING_TYPES: ReadonlySet<string> = new Set([
  'attachedtemplate',
  'oleobject',
  'frame',
  'subdocument',
]);

/** A Windows protocol handler such as ms-msdt: (Follina) or msdt:. */
const PROTOCOL_HANDLER = /(^|[^a-z0-9+.-])(ms-[a-z0-9+.-]*|msdt|search-ms):/i;

/**
 * An NT object-manager path (\??\..., read with slashes) counts as a share:
 * \??\UNC\, \??\Global\UNC\ and \??\GLOBALROOT\Device\Mup\ all reach the
 * network redirector. Only a drive (\??\C:\) is local.
 */
function isNtShare(path: string): boolean {
  return /^\/+\?\?(\/|$)/.test(path) && !/^\/+\?\?\/[a-z]:(\/|$)/i.test(path);
}

/** True when any C0 control character (%00-%1F once decoded) is present. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/** Decode %xx escapes without throwing on malformed ones. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Where a relationship target points:
 * - 'share': a Windows share or remote file host (\\server\share, //server,
 *   \\?\UNC\..., file://host/... with a host other than localhost, file:////...);
 * - 'web': any other URI scheme (http, https, ftp, smb, ...);
 * - 'local': a local or relative path (file:///C:/..., C:\..., Normal.dotm).
 * Backslashes read as slashes and %xx escapes are decoded first.
 */
function targetLocation(rawTarget: string): 'share' | 'web' | 'local' {
  // A control character anywhere (%00-%1F, or a raw tab or newline) is
  // treated as a share: readers may strip it and reveal one.
  const decoded = percentDecode(rawTarget);
  if (hasControlCharacter(decoded)) return 'share';
  // Trim again after decoding: %20 before \\server must not hide it.
  const target = decoded.trim().replace(/\\/g, '/');
  if (target.startsWith('//')) return 'share';
  if (isNtShare(target)) return 'share';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  // No scheme, or a single letter (a drive such as C:), is a local path.
  if (scheme === undefined || scheme.length === 1) return 'local';
  if (scheme !== 'file') return 'web';
  const rest = target.slice('file:'.length);
  let path = rest;
  if (rest.startsWith('//')) {
    const authority = rest.slice(2);
    const host = authority.split('/')[0]?.toLowerCase() ?? '';
    if (host !== '' && host !== 'localhost') return 'share';
    path = authority.slice(host.length);
  }
  // Windows collapses "." and ".." and repeated separators when it turns a
  // file: URL into a path, which can leave a share (\\server\share). So any
  // "//" in the path, any "." or ".." segment, or an NT UNC prefix counts as
  // a share.
  if (path.includes('//') || isNtShare(path)) return 'share';
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'share';
  return 'local';
}

/**
 * .rels rules:
 * - any Target naming an ms-* / msdt / search-ms protocol handler is refused;
 * - an external template, OLE object, frame or sub-document is refused when its
 *   target is on the network (web or share); local paths pass;
 * - any other external relationship except a hyperlink (an image, audio,
 *   video...) is refused when it points at a share, which Office fetches on
 *   open; web images and every hyperlink pass.
 */
function checkRelationships(raw: string): FileSafetyResult {
  const tags = xmlStartTags(raw);
  if (tags === null) return refuse('mime_mismatch');
  for (const tag of tags) {
    if (tag.name !== 'relationship') continue;
    const target = tag.attrs.get('target') ?? '';
    if (
      PROTOCOL_HANDLER.test(target.trim()) ||
      PROTOCOL_HANDLER.test(percentDecode(target.trim()))
    ) {
      return refuse('external_content');
    }
    const mode = (tag.attrs.get('targetmode') ?? '').trim().toLowerCase();
    if (mode !== 'external') continue;
    const kind = (tag.attrs.get('type') ?? '').trim().toLowerCase().split('/').pop() ?? '';
    const location = targetLocation(target);
    if (REMOTE_LOADING_TYPES.has(kind)) {
      if (location !== 'local') return refuse('external_content');
    } else if (kind !== 'hyperlink' && location === 'share') {
      return refuse('external_content');
    }
  }
  return OK;
}

/**
 * Open an OOXML package and apply every rule. `depth` is 0 for the upload and 1
 * for an embedded package; the budget is shared so embeds count toward the caps.
 */
async function inspectOoxml(
  bytes: Uint8Array,
  kind: OoxmlKind,
  depth: number,
  budget: ZipBudget,
): Promise<FileSafetyResult> {
  if (!isZipSignature(bytes)) return refuse('mime_mismatch');
  const read = readCentralDirectory(bytes);
  if (!read.ok) return refuse(read.code);
  const { entries, cdOffset } = read;

  // Declared-size caps first: no inflating a package that already says it is too big.
  budget.entries += entries.length;
  if (budget.entries > ZIP_LIMITS.maxEntries) return refuse('archive_limits');
  const seen = new Set<string>();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    // A duplicate name lets two readers see two different files.
    if (seen.has(lower)) return refuse('mime_mismatch');
    seen.add(lower);
    if ((entry.flags & 0x1) !== 0 || entry.method === METHOD_AES) {
      return refuse('encrypted_file');
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      return refuse('mime_mismatch');
    }
    budget.uncompressedBytes += entry.uncompressedSize;
    if (budget.uncompressedBytes > ZIP_LIMITS.maxTotalUncompressedBytes) {
      return refuse('archive_limits');
    }
    if (
      entry.uncompressedSize >
      ZIP_LIMITS.maxCompressionRatio * Math.max(entry.compressedSize, 1)
    ) {
      return refuse('archive_limits');
    }
  }
  // Overall ratio: this package against its own bytes, and everything counted
  // so far (embeds included) against the uploaded file.
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (
    declaredTotal > ZIP_LIMITS.maxCompressionRatio * bytes.length ||
    budget.uncompressedBytes > ZIP_LIMITS.maxCompressionRatio * budget.uploadBytes
  ) {
    return refuse('archive_limits');
  }

  // Structure: the content-types part and the claimed type's main part.
  if (!seen.has(CONTENT_TYPES_PART) || !seen.has(MAIN_PART[kind])) {
    return refuse('mime_mismatch');
  }

  // Macros, OLE objects and stray embeddings, by name, before any inflating.
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const name = basename(lower);
    if (name.startsWith('vbaproject') || name === 'vbadata.xml') return refuse('blocked_type');
    if (name.endsWith('.bin') && !DATA_BLOB_BIN.test(name)) return refuse('embedded_content');
    if (name.startsWith('oleobject')) return refuse('embedded_content');
    if (lower.includes('embeddings/') && ooxmlKindForName(lower) === null) {
      return refuse('embedded_content');
    }
  }

  // Local headers: each must match its central entry, and entry data may not
  // overlap (overlapping entries are the classic non-recursive zip bomb).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const spans: Array<{ entry: ZipEntry; start: number; end: number }> = [];
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > cdOffset || u32(view, local) !== SIG_LOCAL) return refuse('mime_mismatch');
    if ((u16(view, local + 6) & 0x1) !== 0) return refuse('encrypted_file');
    if (u16(view, local + 8) !== entry.method) return refuse('mime_mismatch');
    const nameLen = u16(view, local + 26);
    if (!sameBytes(bytes.subarray(local + 30, local + 30 + nameLen), entry.nameBytes)) {
      return refuse('mime_mismatch');
    }
    const start = local + 30 + nameLen + u16(view, local + 28);
    const end = start + entry.compressedSize;
    if (end > cdOffset) return refuse('mime_mismatch');
    spans.push({ entry, start, end });
  }
  const ordered = [...spans].sort((x, y) => x.entry.localOffset - y.entry.localOffset);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.entry.localOffset < previous.end
    ) {
      return refuse('archive_limits');
    }
  }

  for (const { entry, start, end } of spans) {
    const lower = entry.name.toLowerCase();
    const embedKind = ooxmlKindForName(lower);
    const isContentTypes = lower === CONTENT_TYPES_PART;
    const isRelationships = lower.endsWith('.rels');
    const keep = isContentTypes || isRelationships || embedKind !== null;
    if (keep && entry.uncompressedSize > MAX_INSPECTED_PART_BYTES) {
      return refuse('archive_limits');
    }
    const inflated = await inflateEntry(entry, bytes.subarray(start, end), keep);
    if (!inflated.ok) return refuse(inflated.code);

    if (isContentTypes) {
      const text = decodeStrictXml(inflated.body ?? new Uint8Array());
      if (text === null) return refuse('mime_mismatch');
      const checked = checkContentTypes(text, kind);
      if (!checked.ok) return checked;
      continue;
    }

    if (isRelationships) {
      const text = decodeStrictXml(inflated.body ?? new Uint8Array());
      if (text === null) return refuse('mime_mismatch');
      const checked = checkRelationships(text);
      if (!checked.ok) return checked;
      continue;
    }

    if (embedKind !== null) {
      // Only a docx/xlsx/pptx may be embedded, and only in the uploaded package.
      if (depth >= ZIP_LIMITS.maxEmbedDepth || inflated.body === null) {
        return refuse('embedded_content');
      }
      if (!isZipSignature(inflated.body)) return refuse('embedded_content');
      const inner = await inspectOoxml(inflated.body, embedKind, depth + 1, budget);
      if (!inner.ok) return inner;
      continue;
    }

    if (isNestedContainer(inflated.head, lower)) return refuse('embedded_content');
  }
  return OK;
}

/**
 * Apply every content rule for an upload whose MIME is already allowlisted and
 * whose leading bytes already match it. Returns the first refusal.
 */
export async function inspectUpload(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<FileSafetyResult> {
  const mime = normalizeMime(input.mimeType);
  if (BLOCKED_MIME_TYPES.has(mime)) return refuse('blocked_type');
  if (isOle2Signature(input.bytes)) return checkOle2(input.bytes);

  const name = checkFilename(input.filename, mime);
  if (!name.ok) return name;

  if (mime === 'application/pdf' && (await pdfNeedsPassword(input.bytes))) {
    return refuse('encrypted_file');
  }

  const kind = ooxmlKindForMime(mime);
  if (kind !== null) {
    return inspectOoxml(input.bytes, kind, 0, {
      entries: 0,
      uncompressedBytes: 0,
      uploadBytes: input.bytes.length,
    });
  }
  return OK;
}
