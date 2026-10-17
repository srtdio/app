import { describe, expect, it, vi } from 'vitest';
import { isSampleKey, sampleThumbKey, withSampleFiles, SAMPLE_KEY_PREFIX } from './asset-read';

describe('sample week files', () => {
  it('recognises only keys under the sample prefix', () => {
    expect(isSampleKey(`${SAMPLE_KEY_PREFIX}launch.jpg`)).toBe(true);
    expect(isSampleKey('ws-1/assets/launch.jpg')).toBe(false);
    expect(isSampleKey(null)).toBe(false);
  });

  it('maps a sample file to its small copy, a PDF to its cover', () => {
    expect(sampleThumbKey('induction-sample/np-01.jpg')).toBe('induction-sample/thumb/np-01.jpg');
    expect(sampleThumbKey('induction-sample/pdf-red.pdf')).toBe(
      'induction-sample/thumb/pdf-red.jpg',
    );
  });

  it('signs a sample key as the site static URL and leaves every other key to R2', async () => {
    const presignGetUrl = vi.fn(async () => 'https://r2.example/signed');
    const signer = withSampleFiles({ presignGetUrl }, 'https://srtd.io/');
    await expect(
      signer.presignGetUrl({
        bucket: '',
        key: 'induction-sample/np-01.jpg',
        expiresInSeconds: 900,
      }),
    ).resolves.toBe('https://srtd.io/induction-sample/np-01.jpg');
    expect(presignGetUrl).not.toHaveBeenCalled();
    await expect(
      signer.presignGetUrl({ bucket: 'assets-x', key: 'a/b.jpg', expiresInSeconds: 900 }),
    ).resolves.toBe('https://r2.example/signed');
    expect(presignGetUrl).toHaveBeenCalledTimes(1);
  });
});
