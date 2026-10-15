// F5 image-pin numbering + slide matching, kept as a pure module so it can be
// unit-tested without mounting PostDetailPage. It runs AFTER the F4 caption pass:
// caption highlights are numbered first, then current-version image pins continue
// the SAME live counter, so a pin's number always follows the captions'. Stale
// pins (made on an older version) are excluded from the live overlay and surface
// only as the kind-agnostic "copy changed" comment chip.

import type { GalleryItem, PostAnnotation, PostVersion } from '@srtdio/posts';
import type { CommentAnnotation } from '@/components/comments/Comments';

/** One current-version pin to draw as a numbered dot over its slide. */
export interface PinDot {
  n: number;
  annotationId: string;
  commentId: string;
  /** Normalised [0,1] position within the rendered image. */
  x: number;
  y: number;
}

export interface PinData {
  /** Dots keyed by asset_attachment_id, so the overlay matches them to a slide. */
  pinsByAttachment: Record<string, PinDot[]>;
  /** Per-comment chips for every pin (stale included), merged into the caption map. */
  pinChipsByCommentId: Record<string, CommentAnnotation>;
  /** The next live display number after captions + current-version pins. */
  nextN: number;
}

/** A short, image-slice-free label for a pin's comment chip. */
export function pinLabel(filename: string | null | undefined): string {
  return filename !== null && filename !== undefined && filename !== ''
    ? `Pin on ${filename}`
    : 'Pin on image';
}

/** A coordinate is renderable only when present and inside the unit range. */
function inUnit(value: number | null): value is number {
  return value !== null && value >= 0 && value <= 1;
}

/**
 * Number the image_pin annotations and match them to gallery slides. Caption
 * highlights are already numbered 1..startN; current-version pins continue from
 * startN so captions keep their numbers and pins take the next. Out-of-range or
 * unmatched pins are skipped from the overlay (never thrown), but a current pin
 * still carries a comment chip; stale pins yield only a greyed chip.
 */
export function buildPinData(
  annotations: PostAnnotation[],
  currentVersionId: string | null,
  versions: PostVersion[],
  gallery: GalleryItem[],
  startN: number,
): PinData {
  const pinsByAttachment: Record<string, PinDot[]> = {};
  const pinChipsByCommentId: Record<string, CommentAnnotation> = {};
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const filenameByAttachment = new Map(gallery.map((g) => [g.assetAttachmentId, g.filename]));

  // Deterministic order: oldest pin numbers first, matching the caption pass.
  const pins = annotations
    .filter((a) => a.kind === 'image_pin')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  let liveN = startN;
  for (const a of pins) {
    const filename =
      a.asset_attachment_id !== null ? filenameByAttachment.get(a.asset_attachment_id) : undefined;
    const quote = pinLabel(filename);
    const versionNumber = versionById.get(a.post_version_id)?.version_number ?? 0;
    const stale = a.post_version_id !== currentVersionId;

    if (stale) {
      pinChipsByCommentId[a.comment_id] = { n: 0, quote, stale: true, versionNumber };
      continue;
    }

    liveN += 1;
    pinChipsByCommentId[a.comment_id] = { n: liveN, quote, stale: false, versionNumber };

    // Overlay dot only for a current-version pin matched to a slide and in range.
    if (a.asset_attachment_id !== null && inUnit(a.image_x) && inUnit(a.image_y)) {
      const dot: PinDot = {
        n: liveN,
        annotationId: a.id,
        commentId: a.comment_id,
        x: a.image_x,
        y: a.image_y,
      };
      const bucket = pinsByAttachment[a.asset_attachment_id];
      if (bucket === undefined) pinsByAttachment[a.asset_attachment_id] = [dot];
      else bucket.push(dot);
    }
  }

  return { pinsByAttachment, pinChipsByCommentId, nextN: liveN };
}

/** The part of the original a frame shows, as fractions of its width and height. */
export interface ShownWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_WINDOW: ShownWindow = { x: 0, y: 0, w: 1, h: 1 };

/**
 * The centre crop a frame of ratio (w / h) takes from an original of w x h, as
 * object-fit: cover draws it. Unknown or zero dimensions show the whole image.
 */
export function coverWindow(
  original: { w: number; h: number } | null,
  frameRatio: number,
): ShownWindow {
  if (original === null || original.w <= 0 || original.h <= 0 || frameRatio <= 0) {
    return FULL_WINDOW;
  }
  const own = original.w / original.h;
  if (own > frameRatio) {
    const w = frameRatio / own;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = own / frameRatio;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/**
 * A tap on the frame, normalised to the frame, mapped to the ORIGINAL image:
 * the value stored in post_annotations image_x / image_y.
 */
export function frameToOriginal(
  point: { x: number; y: number },
  win: ShownWindow,
): { x: number; y: number } {
  return { x: win.x + point.x * win.w, y: win.y + point.y * win.h };
}

export type PinEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * A stored pin (relative to the original) placed on the frame. Inside the
 * window it lands exactly where it was put (edge null). Outside, it clamps to
 * the nearest frame edge and names that edge, so it shows as an edge marker.
 */
export function originalToFrame(
  point: { x: number; y: number },
  win: ShownWindow,
): { x: number; y: number; edge: PinEdge | null } {
  const fx = (point.x - win.x) / win.w;
  const fy = (point.y - win.y) / win.h;
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) return { x: fx, y: fy, edge: null };
  // The axis it overshoots furthest names the edge.
  const overX = fx < 0 ? -fx : fx > 1 ? fx - 1 : 0;
  const overY = fy < 0 ? -fy : fy > 1 ? fy - 1 : 0;
  const edge: PinEdge = overX >= overY ? (fx < 0 ? 'left' : 'right') : fy < 0 ? 'top' : 'bottom';
  return { x: clamp(fx), y: clamp(fy), edge };
}

/** The share of the original a window leaves out, as a whole percent. */
export function cutPercent(win: ShownWindow): number {
  return Math.round((1 - win.w * win.h) * 100);
}
