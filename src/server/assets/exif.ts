// EXIF / metadata stripping for JPEG, dependency-free.
//
// sharp and other native strippers cannot run in the Workers runtime, so we
// rewrite the JPEG marker stream directly: copy the SOI, drop every APPn
// segment except APP0/JFIF (APP1 holds the Exif IFD, which carries the GPS and
// camera tags we must remove) and drop COM comment segments, then copy the
// compressed scan verbatim once we reach SOS. Non-JPEG bytes pass through
// unchanged; this PR only strips JPEG (the case the pipeline tests exercise).

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP1 = 0xe1;
const APP15 = 0xef;

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === SOI;
}

/**
 * Return true if the JPEG still carries an APP1 (Exif) segment. Used by tests to
 * assert that stripping removed the GPS/camera block.
 */
export function hasExifSegment(bytes: Uint8Array): boolean {
  if (!isJpeg(bytes)) {
    return false;
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return false;
    }
    const marker = bytes[i + 1];
    if (marker === SOS || marker === EOI) {
      return false;
    }
    if (marker === APP1) {
      return true;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return false;
}

/**
 * Strip metadata segments from a JPEG. Returns the original reference for
 * non-JPEG input so callers can pass any image type through safely.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpeg(bytes)) {
    return bytes;
  }

  const out: number[] = [0xff, SOI];
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Malformed marker stream: copy the remainder verbatim rather than risk
      // corrupting the file.
      for (let j = i; j < bytes.length; j += 1) {
        out.push(bytes[j] ?? 0);
      }
      break;
    }

    const marker = bytes[i + 1];

    if (marker === EOI) {
      out.push(0xff, EOI);
      break;
    }

    if (marker === SOS) {
      // Start of scan: the compressed image data (and EOI) follow with no
      // further length-prefixed segments. Copy to the end unchanged.
      for (let j = i; j < bytes.length; j += 1) {
        out.push(bytes[j] ?? 0);
      }
      break;
    }

    if (i + 3 >= bytes.length) {
      for (let j = i; j < bytes.length; j += 1) {
        out.push(bytes[j] ?? 0);
      }
      break;
    }

    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    const segEnd = i + 2 + len;
    const drop = (marker !== undefined && marker >= APP1 && marker <= APP15) || marker === COM;

    if (!drop) {
      for (let j = i; j < segEnd && j < bytes.length; j += 1) {
        out.push(bytes[j] ?? 0);
      }
    }
    i = segEnd;
  }

  return new Uint8Array(out);
}
