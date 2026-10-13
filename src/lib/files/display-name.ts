// How a file's name and kind read in chat (decision 152). A long name wraps to
// two lines and is then cut in the MIDDLE, keeping the tail with the extension,
// so "Q3 brand guidelines final.pdf" never loses its ".pdf". Names are never
// end-truncated. The kind label comes from the server-detected mime, never from
// the name. Pure helpers, shared by the chat file bubble and the file viewer.

/** The ellipsis that joins the kept head and tail of a cut name. */
export const NAME_ELLIPSIS = '…';

/**
 * Width budget for two lines of a name in the file bubble, in narrow-glyph
 * units (a Latin letter is 1, a wide CJK glyph 2). Sized for the narrowest
 * phone bubble so the cut name always fits in two lines and CSS never has to
 * clip it.
 */
export const BUBBLE_NAME_BUDGET = 44;

/** The viewer's top bar has one line between its buttons. */
export const VIEWER_NAME_BUDGET = 28;

/** Graphemes of the stem kept before the extension when a name is cut. */
const TAIL_STEM_GRAPHEMES = 6;

/** Split a string into user-perceived characters (grapheme clusters). */
export function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** Wide glyphs (Indic clusters, CJK, kana, hangul, full-width forms, emoji) take two units. */
function isWide(cluster: string): boolean {
  const code = cluster.codePointAt(0) ?? 0;
  return (
    // Indic clusters (Devanagari to Malayalam) set wider than a Latin letter.
    (code >= 0x0900 && code <= 0x0dff) ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function unitsOf(clusters: readonly string[]): number {
  return clusters.reduce((sum, cluster) => sum + (isWide(cluster) ? 2 : 1), 0);
}

/**
 * The name's extension tail including the dot (".pdf"), or '' when it has
 * none. A short second-to-last segment of a known compound ("tar.gz") is kept
 * with it. A leading dot ("." files) is not an extension.
 */
export function extensionTail(name: string): string {
  const last = name.lastIndexOf('.');
  if (last <= 0 || last === name.length - 1) return '';
  const ext = name.slice(last);
  if (ext.length > 9) return '';
  const before = name.lastIndexOf('.', last - 1);
  if (before > 0) {
    const inner = name.slice(before + 1, last).toLowerCase();
    if (inner === 'tar' || inner === 'backup' || inner === 'min') return name.slice(before);
  }
  return ext;
}

/**
 * The name to show within `budget` units: the whole name when it fits,
 * otherwise head + ellipsis + tail, where the tail is the last few graphemes
 * of the stem plus the extension. The tail always survives; only the middle is
 * dropped. An empty name reads "Attachment". Pure.
 */
export function middleTruncate(name: string, budget: number = BUBBLE_NAME_BUDGET): string {
  const trimmed = name.trim();
  if (trimmed === '') return 'Attachment';
  const all = graphemes(trimmed);
  if (unitsOf(all) <= budget) return trimmed;
  const ext = extensionTail(trimmed);
  const stem = graphemes(trimmed.slice(0, trimmed.length - ext.length));
  const extClusters = graphemes(ext);
  const keepStem = Math.min(TAIL_STEM_GRAPHEMES, Math.max(stem.length - 1, 0));
  const tail = [...stem.slice(stem.length - keepStem), ...extClusters];
  const room = budget - unitsOf(tail) - 1;
  const head: string[] = [];
  let used = 0;
  for (const cluster of stem.slice(0, stem.length - keepStem)) {
    const width = isWide(cluster) ? 2 : 1;
    if (used + width > room) break;
    head.push(cluster);
    used += width;
  }
  return `${head.join('').trimEnd()}${NAME_ELLIPSIS}${tail.join('')}`;
}

/** Office mimes the viewer will render in the next PR (docx, xlsx, pptx). */
const OFFICE_LABELS: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
};

/** True for docx, xlsx and pptx. */
export function isOfficeMime(mime: string): boolean {
  return OFFICE_LABELS[mime.toLowerCase()] !== undefined;
}

/** The kind label under a file's name, from its mime alone ("PDF", "Video", "Word"). Pure. */
export function fileKindLabel(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (m === 'application/pdf') return 'PDF';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  if (m.startsWith('image/')) return 'Image';
  const office = OFFICE_LABELS[m];
  if (office !== undefined) return office;
  if (m === 'text/csv') return 'CSV';
  if (m === 'text/plain') return 'Text';
  if (m === 'application/zip') return 'ZIP';
  return 'File';
}
