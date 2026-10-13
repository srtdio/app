// An OOXML package: the zip, its main part (found through _rels/.rels, never
// by file name) and the part's relationships. Internal targets only: a
// relationship with TargetMode="External" is dropped here, so no reader can
// follow one. Worker only.

import { scanXml } from './xml';
import { readZipDirectory, readZipEntry, ZipError, type ZipEntry } from './zip';

/** One XML part is never more than this once inflated. */
export const PART_MAX_BYTES = 64 * 1024 * 1024;
/** All parts read from one package together. */
export const PACKAGE_MAX_BYTES = 160 * 1024 * 1024;

export type PackageKind = 'docx' | 'xlsx' | 'pptx';

const MAIN_TYPES: Readonly<Record<string, PackageKind>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml': 'pptx',
};

export interface Relationship {
  id: string;
  type: string;
  /** Resolved package path ("word/media/image1.png"). */
  target: string;
}

/** Resolve a relationship target against the source part's folder. Pure. */
export function resolveTarget(sourcePart: string, target: string): string {
  const base = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return base.join('/');
}

/** The rels file for a part: "word/document.xml" -> "word/_rels/document.xml.rels". Pure. */
export function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class OfficePackage {
  private readonly entries: Map<string, ZipEntry>;
  private read = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.entries = readZipDirectory(bytes);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** A part's bytes, counted against the package cap; null when absent. */
  bytesOf(path: string, maxBytes = PART_MAX_BYTES): Uint8Array | null {
    const entry = this.entries.get(path);
    if (entry === undefined) return null;
    if (this.read + entry.size > PACKAGE_MAX_BYTES) {
      throw new ZipError('package inflates past cap', 'too_large');
    }
    const out = readZipEntry(this.bytes, entry, maxBytes);
    this.read += out.length;
    return out;
  }

  /** A part as text (UTF-8), or null when absent. */
  text(path: string): string | null {
    const bytes = this.bytesOf(path);
    return bytes === null ? null : utf8.decode(bytes);
  }

  /** The internal relationships of a part, by id. */
  relationships(part: string): Map<string, Relationship> {
    const out = new Map<string, Relationship>();
    const xml = this.text(relsPath(part));
    if (xml === null) return out;
    scanXml(xml, {
      open(name, attrs) {
        if (name !== 'Relationship') return;
        const id = attrs.Id;
        const target = attrs.Target;
        if (id === undefined || target === undefined) return;
        if ((attrs.TargetMode ?? '').toLowerCase() === 'external') return;
        out.set(id, { id, type: attrs.Type ?? '', target: resolveTarget(part, target) });
      },
      close() {},
      text() {},
    });
    return out;
  }

  /** The main part and what kind of package this is, from _rels/.rels and [Content_Types].xml. */
  main(): { kind: PackageKind; part: string } | null {
    let part: string | null = null;
    for (const rel of this.relationships('').values()) {
      if (rel.type.endsWith('/officeDocument')) {
        part = rel.target;
        break;
      }
    }
    if (part === null) return null;
    const types = this.text('[Content_Types].xml');
    if (types === null) return null;
    let kind: PackageKind | null = null;
    const wanted = `/${part}`;
    scanXml(types, {
      open(name, attrs) {
        if (name === 'Override' && attrs.PartName === wanted) {
          kind = MAIN_TYPES[(attrs.ContentType ?? '').toLowerCase()] ?? null;
        }
      },
      close() {},
      text() {},
    });
    const found: PackageKind | null = kind;
    return found === null ? null : { kind: found, part };
  }
}
