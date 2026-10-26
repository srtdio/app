// Byte fixtures for the upload file-safety tests. Everything is built in-process
// from small strings: no files on disk, no network, and no real malware (a
// "macro" is an empty vbaProject.bin entry; an "executable" is just a name).

import { createCipheriv, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const encoder = new TextEncoder();

export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  png: 'image/png',
  jpeg: 'image/jpeg',
} as const;

interface ZipFile {
  name: string;
  data: Uint8Array | string;
  /** Default 'deflate'. */
  method?: 'store' | 'deflate';
  /** Sets general-purpose flag bit 0 (traditional ZIP encryption). */
  encrypted?: boolean;
  /** Overrides the uncompressed size written to both headers (a lying header). */
  declaredSize?: number;
  /** Writes a different name into the local header than the central directory. */
  localName?: string;
}

/**
 * A central-directory entry with no local header of its own: it points at the
 * data of entry `into`, which must itself hold a stored local header for `name`
 * (see {@link storedLocalHeader}). Builds the overlapping-entry zip bomb shape.
 */
interface ZipAlias {
  name: string;
  into: string;
  size: number;
}

/** A stored (method 0) local header plus data, for use inside another entry. */
export function storedLocalHeader(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name);
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint32(14, crc32(data), true);
  v.setUint32(18, data.length, true);
  v.setUint32(22, data.length, true);
  v.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** A spec-shaped ZIP: local headers + data, central directory, EOCD. */
export function buildZip(files: readonly ZipFile[], aliases: readonly ZipAlias[] = []): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const dataStart = new Map<string, number>();
  let offset = 0;
  for (const file of files) {
    const raw = toBytes(file.data);
    const deflate = (file.method ?? 'deflate') === 'deflate';
    const body = deflate ? new Uint8Array(deflateRawSync(raw, { level: 9 })) : raw;
    const name = encoder.encode(file.name);
    const localName = encoder.encode(file.localName ?? file.name);
    const flags = file.encrypted ? 0x1 : 0;
    const method = deflate ? 8 : 0;
    const size = file.declaredSize ?? raw.length;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + localName.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    local.set(body, 30 + localName.length);
    dataStart.set(file.name, offset + 30 + localName.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  for (const alias of aliases) {
    const name = encoder.encode(alias.name);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, alias.size, true);
    cv.setUint32(24, alias.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, dataStart.get(alias.into) ?? 0, true);
    central.set(name, 46);
    centrals.push(central);
  }
  const count = files.length + aliases.length;
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

type Kind = 'docx' | 'xlsx' | 'pptx';

const MAIN: Record<Kind, { part: string; type: string }> = {
  docx: {
    part: 'word/document.xml',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    part: 'xl/workbook.xml',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
  pptx: {
    part: 'ppt/presentation.xml',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
};

const MACRO_MAIN: Record<Kind, string> = {
  docx: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  pptx: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
};

function contentTypes(mainPart: string, mainType: string, extra = ''): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/${mainPart}" ContentType="${mainType}"/>`,
    extra,
    '</Types>',
  ].join('');
}

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

interface OfficeOptions {
  /** Use the macro-enabled main content type (a docm/xlsm/pptm). */
  macroContentType?: boolean;
  /** Extra entries placed in the package. */
  extra?: readonly ZipFile[];
  /** Replace [Content_Types].xml entirely. */
  contentTypesXml?: string;
  /** Override the main part's body (e.g. a large sheet). */
  mainBody?: Uint8Array | string;
}

/** A minimal, valid Office Open XML package of the given kind. */
export function office(
  kind: Kind,
  options: OfficeOptions = {},
  aliases: readonly ZipAlias[] = [],
): Uint8Array {
  const main = MAIN[kind];
  return buildZip(
    [
      {
        name: '[Content_Types].xml',
        data:
          options.contentTypesXml ??
          contentTypes(main.part, options.macroContentType ? MACRO_MAIN[kind] : main.type),
      },
      { name: '_rels/.rels', data: RELS },
      { name: main.part, data: options.mainBody ?? `<root kind="${kind}">Hello</root>` },
      ...(options.extra ?? []),
    ],
    aliases,
  );
}

/** Valid [Content_Types].xml text for a kind, with optional extra markup. */
export function contentTypesFor(kind: Kind, extra = ''): string {
  return contentTypes(MAIN[kind].part, MAIN[kind].type, extra);
}

/** Bytes of the repeated cell in {@link repetitiveXlsx}. */
const REPEATED_CELL = '<c><v>1</v></c>';

/**
 * An xlsx whose 8 MiB sheet is one cell repeated: deflate level 9 packs it at
 * about 515:1, a realistic "highly repetitive sheet" well under the 1000:1 cap.
 */
export function repetitiveXlsx(): { bytes: Uint8Array; sheetBytes: number } {
  const sheet = REPEATED_CELL.repeat(Math.ceil((8 * 1024 * 1024) / REPEATED_CELL.length));
  return { bytes: office('xlsx', { mainBody: sheet }), sheetBytes: sheet.length };
}

/** OLE2 compound-file header, optionally naming an EncryptedPackage stream. */
export function ole2(options: { encryptedPackage?: boolean } = {}): Uint8Array {
  const header = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const out = new Uint8Array(1024);
  out.set(header, 0);
  if (options.encryptedPackage) {
    const name = 'EncryptedPackage';
    for (let i = 0; i < name.length; i += 1) out[512 + i * 2] = name.charCodeAt(i);
  }
  return out;
}

export function pdf(options: { encrypted?: boolean } = {}): Uint8Array {
  const trailer = options.encrypted
    ? 'trailer\n<< /Root 1 0 R /Encrypt 5 0 R /ID [<00><00>] >>\n'
    : 'trailer\n<< /Root 1 0 R >>\n';
  return encoder.encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /EncryptMetadata false >>\nendobj\n${trailer}%%EOF\n`,
  );
}

/** An ISO-BMFF header with an mp4 brand. */
export function mp4(): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

export function png(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
  ]);
}

export function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

export function svg(): Uint8Array {
  return encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
}

// ---------------------------------------------------------------------------
// Encrypted PDFs (standard security handler), built with node:crypto as an
// independent implementation of ISO 32000 Algorithms 2-5 and 2.A/2.B.
// ---------------------------------------------------------------------------

const PDF_PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);

function md5(...parts: Uint8Array[]): Buffer {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff;
    [s[i], s[j]] = [s[j] ?? 0, s[i] ?? 0];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + (s[i] ?? 0)) & 0xff;
    [s[i], s[j]] = [s[j] ?? 0, s[i] ?? 0];
    out[k] = (data[k] ?? 0) ^ (s[((s[i] ?? 0) + (s[j] ?? 0)) & 0xff] ?? 0);
  }
  return out;
}

function padPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, 'latin1'), PDF_PAD]).subarray(0, 32);
}

function hash2b(password: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([password, salt, udata]))
    .digest();
  let e = Buffer.alloc(0);
  for (let round = 0; round < 64 || (e.at(-1) ?? 0) > round - 32; round += 1) {
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([password, k, udata])));
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    e = Buffer.concat([cipher.update(k1), cipher.final()]);
    const sum = [...e.subarray(0, 16)].reduce((a, b) => a + b, 0) % 3;
    k = createHash(sum === 0 ? 'sha256' : sum === 1 ? 'sha384' : 'sha512')
      .update(e)
      .digest();
  }
  return k.subarray(0, 32);
}

type PdfRevision = 2 | 3 | 4 | 5 | 6;

interface EncryptedPdfOptions {
  revision: PdfRevision;
  /** '' is an owner-only lock: the file opens without a password. */
  userPassword: string;
  /** Write /O and /U as escaped literal strings instead of hex. */
  literalStrings?: boolean;
  /** Use another security handler (public-key /Adobe.PubSec). */
  filter?: string;
}

function pdfLiteral(bytes: Uint8Array): string {
  let out = '(';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte === 0x0d) out += '\\r';
    else if (byte === 0x0a) out += '\\n';
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** A one-page PDF locked with the given revision of the standard handler. */
export function encryptedPdf(options: EncryptedPdfOptions): Uint8Array {
  const { revision, userPassword } = options;
  const id0 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const permissions = -3904;
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const n = revision === 2 ? 5 : 16;
  let o: Buffer;
  let u: Buffer;
  let header: string;
  if (revision <= 4) {
    let ownerHash = md5(padPassword('ownerpw'));
    if (revision >= 3) for (let i = 0; i < 50; i += 1) ownerHash = md5(ownerHash.subarray(0, n));
    const ownerKey = ownerHash.subarray(0, n);
    o = rc4(ownerKey, padPassword(userPassword));
    if (revision >= 3) {
      for (let i = 1; i <= 19; i += 1)
        o = rc4(
          ownerKey.map((b) => b ^ i),
          o,
        );
    }
    let keyHash = md5(padPassword(userPassword), o, p, id0);
    if (revision >= 3) for (let i = 0; i < 50; i += 1) keyHash = md5(keyHash.subarray(0, n));
    const key = keyHash.subarray(0, n);
    if (revision === 2) {
      u = rc4(key, PDF_PAD);
    } else {
      let x = rc4(key, md5(PDF_PAD, id0));
      for (let i = 1; i <= 19; i += 1)
        x = rc4(
          key.map((b) => b ^ i),
          x,
        );
      u = Buffer.concat([x, Buffer.alloc(16)]);
    }
    header =
      revision === 2
        ? '/V 1 /R 2 /Length 40'
        : revision === 3
          ? '/V 2 /R 3 /Length 128'
          : '/V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF';
  } else {
    const validationSalt = Buffer.from('0102030405060708', 'hex');
    const keySalt = Buffer.from('1112131415161718', 'hex');
    const password = Buffer.from(userPassword, 'utf8');
    const hash =
      revision === 5
        ? createHash('sha256')
            .update(Buffer.concat([password, validationSalt]))
            .digest()
        : hash2b(password, validationSalt, Buffer.alloc(0));
    u = Buffer.concat([hash, validationSalt, keySalt]);
    o = Buffer.alloc(48, 0x5a);
    header = `/V 5 /R ${revision} /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /OE <${'00'.repeat(32)}> /UE <${'00'.repeat(32)}> /Perms <${'00'.repeat(16)}>`;
  }
  const str = (bytes: Buffer) =>
    options.literalStrings ? pdfLiteral(bytes) : `<${bytes.toString('hex')}>`;
  const filter = options.filter ?? 'Standard';
  const encrypt =
    filter === 'Standard'
      ? `<< /Filter /Standard ${header} /O ${str(o)} /U ${str(u)} /P ${permissions} >>`
      : `<< /Filter /${filter} /SubFilter /adbe.pkcs7.s5 /V 4 /R 4 /Recipients [<3082>] >>`;
  const text = [
    '%PDF-1.7',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '7 0 obj',
    encrypt,
    'endobj',
    'trailer',
    `<< /Root 1 0 R /Encrypt 7 0 R /ID [<${id0.toString('hex')}><${id0.toString('hex')}>] >>`,
    '%%EOF',
    '',
  ].join('\n');
  return Uint8Array.from(Buffer.from(text, 'latin1'));
}

/** Relationship XML for a .rels part, from {Type, Target, TargetMode?} rows. */
export function relationships(
  rows: ReadonlyArray<{ type: string; target: string; external?: boolean }>,
  prefix = '',
): string {
  const tag = prefix === '' ? 'Relationship' : `${prefix}:Relationship`;
  const root = prefix === '' ? 'Relationships' : `${prefix}:Relationships`;
  const ns =
    prefix === ''
      ? 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
      : `xmlns:${prefix}="http://schemas.openxmlformats.org/package/2006/relationships"`;
  const body = rows
    .map(
      (row, i) =>
        `<${tag} Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${row.type}" Target="${row.target}"${row.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} ${ns}>${body}</${root}>`;
}
