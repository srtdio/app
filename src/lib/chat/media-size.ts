// The natural pixel size of a photo picked in the chat composer, read at PICK
// time (never on a paint path), so the single-photo bubble paints its final
// box on the first frame of the send: the send carries it as thumbW/thumbH,
// which also rides the recorded attachment meta (thumb_w/thumb_h) so every
// receiver paints the same box. Fire and forget: nothing awaits it. A read
// that has not landed by Send just leaves the size off; the bubble then reads
// it from its own image before revealing (MessageAttachments).

/** A picked file's natural size, px. */
export interface PickedSize {
  width: number;
  height: number;
}

const sizes = new WeakMap<File, PickedSize>();

/** A positive, finite pixel count, rounded; else null. Pure. */
function px(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** Record a picked file's size (both sides positive), else nothing. */
export function rememberPickedSize(file: File, width: number, height: number): void {
  const w = px(width);
  const h = px(height);
  if (w === null || h === null) return;
  sizes.set(file, { width: w, height: h });
}

/** The size read for this picked file, when it has landed. */
export function pickedSize(file: File | null | undefined): PickedSize | undefined {
  return file != null ? sizes.get(file) : undefined;
}

/**
 * The attachment fields for a picked file's size: thumbW/thumbH when known,
 * else none (the attachment then carries no box). Pure apart from the lookup.
 */
export function pickedSizeFields(file: File | null | undefined): {
  thumbW?: number;
  thumbH?: number;
} {
  const size = pickedSize(file);
  return size !== undefined ? { thumbW: size.width, thumbH: size.height } : {};
}

/**
 * Start reading a picked photo's natural size (decode via createImageBitmap,
 * else an Image on its preview URL). Never throws, never awaited by the
 * caller; anything but an image is ignored.
 */
export function readPickedSize(file: File, previewUrl: string | null): void {
  if (sizes.has(file)) return;
  if (file.type.startsWith('video/')) {
    readFromVideo(file);
    return;
  }
  if (!file.type.startsWith('image/')) return;
  if (typeof createImageBitmap === 'function') {
    void createImageBitmap(file)
      .then((bitmap) => {
        rememberPickedSize(file, bitmap.width, bitmap.height);
        bitmap.close();
      })
      .catch(() => readFromImage(file, previewUrl));
    return;
  }
  readFromImage(file, previewUrl);
}

/** A picked video's size from its metadata (videoWidth/videoHeight); never throws. */
function readFromVideo(file: File): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  const done = (): void => {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
  };
  video.preload = 'metadata';
  video.muted = true;
  video.onloadedmetadata = () => {
    rememberPickedSize(file, video.videoWidth, video.videoHeight);
    done();
  };
  video.onerror = done;
  video.src = url;
}

function readFromImage(file: File, previewUrl: string | null): void {
  if (previewUrl === null || typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => rememberPickedSize(file, img.naturalWidth, img.naturalHeight);
  img.src = previewUrl;
}
