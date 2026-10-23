// The soft file prompt: which kinds of file a format usually carries, and the
// confirm copy when an attached file does not match. Never blocks; the person
// keeps or removes the file. Pure so it unit-tests without a DOM.

export type FileKind = 'image' | 'video' | 'document' | 'other';

/** The kind of an attached file, from its MIME type. */
export function fileKindOf(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return 'other';
}

/**
 * The kinds a format usually carries on a platform. [] = no file expected
 * (text, link); null = no expectation (thread, unknown).
 */
export function expectedKinds(platform: string, format: string): readonly FileKind[] | null {
  if (platform === 'youtube_shorts') return ['video'];
  switch (format) {
    case 'reel':
    case 'video':
    case 'short':
      return ['video'];
    case 'single_image':
      return ['image'];
    case 'story':
      return ['image', 'video'];
    case 'carousel':
      return platform === 'linkedin' ? ['document', 'image'] : ['image', 'video'];
    case 'text':
    case 'link':
      return [];
    default:
      return null;
  }
}

/** True when a file of this kind is not what the format usually carries. */
export function isMismatch(platform: string, format: string, kind: FileKind): boolean {
  const expected = expectedKinds(platform, format);
  return expected !== null && !expected.includes(kind);
}

const ONE: Record<FileKind, string> = {
  image: 'an image',
  video: 'a video',
  document: 'a PDF',
  other: 'a file',
};

const MANY: Record<FileKind, string> = {
  image: 'images',
  video: 'videos',
  document: 'PDFs',
  other: 'files',
};

function expectedPhrase(expected: readonly FileKind[]): string {
  if (expected.length === 0) return 'no file';
  if (expected.length === 1) return ONE[expected[0] ?? 'other'];
  if (expected.includes('document')) return 'a PDF or images';
  return 'an image or video';
}

export interface FilePrompt {
  question: string;
  keepLabel: string;
  removeLabel: string;
}

/**
 * The confirm copy for files that do not match the format, or null when every
 * file matches. kinds are the mismatched files' kinds (one per file).
 */
export function filePrompt(
  platform: string,
  format: string,
  kinds: readonly FileKind[],
): FilePrompt | null {
  const expected = expectedKinds(platform, format);
  const off = kinds.filter((kind) => expected !== null && !expected.includes(kind));
  if (expected === null || off.length === 0) return null;
  const first = off[0] ?? 'other';
  const same = off.every((kind) => kind === first);
  const what =
    off.length === 1 ? ONE[first] : same ? `${off.length} ${MANY[first]}` : `${off.length} files`;
  return {
    question: `This format usually has ${expectedPhrase(expected)}. Go with ${what}?`,
    keepLabel: 'Yes, keep',
    removeLabel: off.length === 1 ? 'No, remove it' : 'No, remove them',
  };
}

/**
 * The attached files that do not match the format, in order. Links and files
 * without a known MIME type are never flagged.
 */
export function mismatchedFiles<T extends { kind: string; mime?: string }>(
  platform: string,
  format: string,
  items: readonly T[],
): T[] {
  return items.filter(
    (item) =>
      item.kind !== 'link' &&
      item.mime !== undefined &&
      isMismatch(platform, format, fileKindOf(item.mime)),
  );
}

/**
 * The format a first file sets while the person has not touched Format: the
 * platform's first format that carries only that kind (image: its single-image
 * format, video: its video format). null when the platform has none (keep the
 * current format). Reads the same table as the soft prompt above.
 */
export function formatForFile(
  platform: string,
  formats: readonly string[],
  kind: FileKind,
): string | null {
  if (kind !== 'image' && kind !== 'video') return null;
  for (const format of formats) {
    const expected = expectedKinds(platform, format);
    if (expected !== null && expected.length === 1 && expected[0] === kind) return format;
  }
  return null;
}

/**
 * The full sheet's format before any file: the platform's first format, unless
 * that one needs a video and the platform has a single-image format (Instagram
 * opens on Single image, not Reel).
 */
export function untouchedDefaultFormat(platform: string, formats: readonly string[]): string {
  const first = formats[0] ?? '';
  const expected = expectedKinds(platform, first);
  // A text or link format (no file expected) never counts as needing a video.
  const needsVideo =
    expected !== null && expected.length > 0 && expected.every((kind) => kind === 'video');
  if (needsVideo && formats.includes('single_image')) return 'single_image';
  return first;
}
