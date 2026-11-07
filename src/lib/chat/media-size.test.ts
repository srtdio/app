// D1: a picked photo's natural size is read at pick time (never on paint) and
// rides the send as thumbW/thumbH, so the single-photo bubble paints its final
// box on the first frame.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pickedSize,
  pickedSizeFields,
  readPickedSize,
  rememberPickedSize,
} from '@/lib/chat/media-size';

afterEach(() => {
  vi.unstubAllGlobals();
});

const photo = (): File => new File(['x'], 'p.jpg', { type: 'image/jpeg' });

describe('picked size', () => {
  it('nothing known: no fields (the bubble then reads the image before showing)', () => {
    const file = photo();
    expect(pickedSize(file)).toBeUndefined();
    expect(pickedSizeFields(file)).toEqual({});
    expect(pickedSizeFields(null)).toEqual({});
  });

  it('remembered: thumbW/thumbH; bad sizes are ignored', () => {
    const file = photo();
    rememberPickedSize(file, 0, 10);
    expect(pickedSizeFields(file)).toEqual({});
    rememberPickedSize(file, 3024.4, 4032);
    expect(pickedSizeFields(file)).toEqual({ thumbW: 3024, thumbH: 4032 });
  });

  it('readPickedSize decodes once with createImageBitmap and closes the bitmap', async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 1200, height: 900, close }));
    vi.stubGlobal('createImageBitmap', decode);
    const file = photo();
    readPickedSize(file, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    expect(pickedSize(file)).toEqual({ width: 1200, height: 900 });
    readPickedSize(file, null);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('ignores anything that is not an image', () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    readPickedSize(new File(['x'], 'a.pdf', { type: 'application/pdf' }), null);
    expect(decode).not.toHaveBeenCalled();
  });
});
