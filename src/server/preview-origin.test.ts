import { describe, expect, it } from 'vitest';
import { isPreviewOrigin } from './preview-origin';

describe('isPreviewOrigin', () => {
  it('accepts a PR preview alias of the srtdio-app Pages project', () => {
    expect(isPreviewOrigin('https://pr-546.srtdio-app.pages.dev')).toBe(true);
    expect(isPreviewOrigin('https://3b4fc68f.srtdio-app.pages.dev')).toBe(true);
  });

  it('rejects other hosts, schemes and look-alikes', () => {
    expect(isPreviewOrigin('https://srtdio-app.pages.dev')).toBe(false);
    expect(isPreviewOrigin('http://pr-546.srtdio-app.pages.dev')).toBe(false);
    expect(isPreviewOrigin('https://pr-546.other-app.pages.dev')).toBe(false);
    expect(isPreviewOrigin('https://pr-546.srtdio-app.pages.dev.evil.com')).toBe(false);
    expect(isPreviewOrigin('https://evil.com/.srtdio-app.pages.dev')).toBe(false);
    expect(isPreviewOrigin('https://a.b.srtdio-app.pages.dev')).toBe(false);
  });
});
