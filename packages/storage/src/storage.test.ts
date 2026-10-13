import { describe, expect, it } from 'vitest';
import { buildR2Key, buildThumbnailKey } from './storage';

const ASSET = '55555555-5555-7555-8555-555555555555';

describe('buildThumbnailKey', () => {
  it('keys a pdf thumbnail under the pdf folder next to the version bytes', () => {
    expect(buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 })).toBe(
      `pdf/${ASSET}/v1-thumb.jpg`,
    );
  });

  it('keys a video thumbnail under the pluralized videos folder', () => {
    expect(buildThumbnailKey({ kind: 'video', assetId: ASSET, versionNumber: 3 })).toBe(
      `videos/${ASSET}/v3-thumb.jpg`,
    );
  });

  it('keys a document thumbnail under the docs folder', () => {
    expect(buildThumbnailKey({ kind: 'document', assetId: ASSET, versionNumber: 2 })).toBe(
      `docs/${ASSET}/v2-thumb.jpg`,
    );
  });

  it('maps image to images and falls back to the kind for other kinds', () => {
    expect(buildThumbnailKey({ kind: 'image', assetId: ASSET, versionNumber: 1 })).toBe(
      `images/${ASSET}/v1-thumb.jpg`,
    );
    expect(buildThumbnailKey({ kind: 'spreadsheet', assetId: ASSET, versionNumber: 1 })).toBe(
      `spreadsheet/${ASSET}/v1-thumb.jpg`,
    );
  });

  it('shares the folder and version prefix of the version key for the same version', () => {
    const versionKey = buildR2Key({
      kind: 'pdf',
      assetId: ASSET,
      versionNumber: 4,
      filename: 'brief.pdf',
    });
    const thumbKey = buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 4 });
    expect(versionKey).toBe(`pdf/${ASSET}/v4-brief.pdf`);
    expect(thumbKey).not.toBe(versionKey);
    expect(thumbKey.slice(0, thumbKey.lastIndexOf('-'))).toBe(
      versionKey.slice(0, versionKey.lastIndexOf('-')),
    );
  });
});

describe('buildR2Key (unchanged)', () => {
  it('keeps the {kindFolder}/{asset}/v{n}-{filename} layout', () => {
    expect(
      buildR2Key({ kind: 'image', assetId: ASSET, versionNumber: 1, filename: 'photo.png' }),
    ).toBe(`images/${ASSET}/v1-photo.png`);
    expect(
      buildR2Key({ kind: 'video', assetId: ASSET, versionNumber: 2, filename: 'clip.mp4' }),
    ).toBe(`videos/${ASSET}/v2-clip.mp4`);
    expect(
      buildR2Key({ kind: 'document', assetId: ASSET, versionNumber: 1, filename: 'a.docx' }),
    ).toBe(`docs/${ASSET}/v1-a.docx`);
    expect(buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'a.pdf' })).toBe(
      `pdf/${ASSET}/v1-a.pdf`,
    );
  });

  it('still sanitizes the filename segment', () => {
    expect(
      buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'my file?.pdf' }),
    ).toBe(`pdf/${ASSET}/v1-my_file_.pdf`);
    expect(buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: '...' })).toBe(
      `pdf/${ASSET}/v1-file`,
    );
  });

  it('keys an uploaded file literally named thumb.jpg to the thumbnail key', () => {
    // The collision the pipeline guards against: same folder, version, and name.
    expect(
      buildR2Key({ kind: 'pdf', assetId: ASSET, versionNumber: 1, filename: 'thumb.jpg' }),
    ).toBe(buildThumbnailKey({ kind: 'pdf', assetId: ASSET, versionNumber: 1 }));
  });
});
