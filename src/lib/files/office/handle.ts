// The office Worker's request handler, kept free of Worker globals so tests
// call it directly. Guards run before any parse: the 20 MiB cap, then an OLE2
// container (a password-protected or encrypted Office file, or a legacy
// .doc/.xls) is refused as locked. The package's own main part decides
// docx/xlsx/pptx; when the server stated a mime, the two must agree.

import { readDocxThumb, readDocxView } from './docx';
import { OfficePackage, type PackageKind } from './package';
import {
  DOCX_MIME,
  OFFICE_MAX_BYTES,
  PPTX_MIME,
  XLSX_MIME,
  type OfficeFailure,
  type OfficeRequest,
  type OfficeResponse,
} from './types';
import { XmlError } from './xml';
import { readXlsxThumb, readXlsxView } from './xlsx';
import { ZipError } from './zip';

const MIME_KIND: Readonly<Record<string, PackageKind>> = {
  [DOCX_MIME]: 'docx',
  [XLSX_MIME]: 'xlsx',
  [PPTX_MIME]: 'pptx',
};

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** True for an OLE2 compound file (how Office wraps an encrypted OOXML file). Pure. */
function isOle2(bytes: Uint8Array): boolean {
  return OLE2_MAGIC.every((b, i) => bytes[i] === b);
}

function failure(error: unknown): OfficeFailure {
  if (error instanceof ZipError) return error.code;
  if (error instanceof XmlError) return 'corrupt';
  return 'failed';
}

/** Answer one request. Never throws. */
export function handleOfficeRequest(request: OfficeRequest): OfficeResponse {
  try {
    const bytes = new Uint8Array(request.bytes);
    if (bytes.byteLength > OFFICE_MAX_BYTES) return { ok: false, reason: 'too_large' };
    if (isOle2(bytes)) return { ok: false, reason: 'locked' };
    const pkg = new OfficePackage(bytes);
    const main = pkg.main();
    if (main === null) return { ok: false, reason: 'corrupt' };
    if (request.mime !== null) {
      const stated = MIME_KIND[request.mime.toLowerCase()];
      if (stated !== main.kind) return { ok: false, reason: 'mismatch' };
    }
    if (main.kind === 'pptx') {
      return request.op === 'view'
        ? { ok: true, op: 'view', result: { kind: 'unsupported' } }
        : { ok: true, op: 'thumb', result: { kind: 'unsupported' } };
    }
    if (request.op === 'view') {
      const result =
        main.kind === 'docx' ? readDocxView(pkg, main.part) : readXlsxView(pkg, main.part);
      return { ok: true, op: 'view', result };
    }
    const result =
      main.kind === 'docx' ? readDocxThumb(pkg, main.part) : readXlsxThumb(pkg, main.part);
    return { ok: true, op: 'thumb', result };
  } catch (error) {
    return { ok: false, reason: failure(error) };
  }
}
